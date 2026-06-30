/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { loadSkills } from '../context';
import { runAgentTurn } from '../llm/agent';
import { LlmMessage } from '../llm/anthropicClient';
import { getApiKey, hasApiKey } from '../llm/apiKey';
import { NOTEBOOK_FILENAME } from '../notebook';
import { createPlanner } from '../planner';
import { MiniQualiaStore } from '../storage';
import { agentLabel } from '../writeup';
import { getNonce } from '../webview/nonce';

/** A role for a transcript line in the chat panel. */
export type TranscriptRole = 'you' | 'miniqualia' | 'system' | 'tool';

const MODELS = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'];
const INDEPENDENCE = ['low', 'medium', 'high', 'infinity'];
const STATE_KEY = 'miniQualia.chat';

interface TranscriptEntry {
	kind: 'transcript' | 'assistant' | 'tool';
	role?: TranscriptRole;
	text?: string;
	label?: string;
	output?: string;
}

/**
 * The "MiniQualia Chat" webview view (secondary side bar). An agentic chat like
 * Qualia/Cursor: messages run the LLM tool loop over the workspace/notebook.
 * Supports a model + independence picker, slash-skill autocomplete, folded
 * tool-call output, a Stop button, live token usage, and a persisted transcript.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {

	static readonly viewType = 'miniQualia.chat';
	static current: ChatViewProvider | undefined;

	private view?: vscode.WebviewView;
	private readonly history: LlmMessage[] = [];
	private transcript: TranscriptEntry[] = [];
	private busy = false;
	private currentAssistant = '';
	private abort: AbortController | undefined;
	private tokensIn = 0;
	private tokensOut = 0;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly store: MiniQualiaStore
	) {
		ChatViewProvider.current = this;
		const saved = context.workspaceState.get<{ history?: LlmMessage[]; transcript?: TranscriptEntry[] }>(STATE_KEY);
		if (saved?.history) { this.history.push(...saved.history); }
		if (saved?.transcript) { this.transcript = saved.transcript; }
		this.store.onDidChange(() => this.updateSummary(), undefined, context.subscriptions);
		this.context.secrets.onDidChange(() => this.updateKeyStatus(), undefined, context.subscriptions);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
		view.webview.html = this.getHtml(view.webview);
		view.webview.onDidReceiveMessage((m: { type: string; text?: string; prompt?: string; value?: string }) => this.onMessage(m));
		view.onDidChangeVisibility(() => { if (view.visible) { this.refresh(); } });
		this.refresh();
		if (this.transcript.length) {
			this.post({ type: 'restore', entries: this.transcript });
		}
	}

	private refresh(): void {
		this.updateSummary();
		this.updateKeyStatus();
		void this.updateSkills();
	}

	private async onMessage(message: { type: string; text?: string; prompt?: string; value?: string }): Promise<void> {
		const cfg = vscode.workspace.getConfiguration('miniQualia');
		switch (message.type) {
			case 'ready': this.refresh(); break;
			case 'userMessage': await this.handleUserMessage(message.text ?? ''); break;
			case 'stop': this.abort?.abort(); break;
			case 'clear': this.clearTranscript(); break;
			case 'setModel': await cfg.update('model', message.value, vscode.ConfigurationTarget.Global); this.updateKeyStatus(); break;
			case 'setIndependence': await cfg.update('independence', message.value, vscode.ConfigurationTarget.Global); this.updateKeyStatus(); break;
			case 'plan': await vscode.commands.executeCommand('miniQualia.planResearchTasks', message.prompt); break;
			case 'runReady': await vscode.commands.executeCommand('miniQualia.runReadyTasks'); break;
			case 'capture': await vscode.commands.executeCommand('miniQualia.captureFinding'); break;
			case 'export': await vscode.commands.executeCommand('miniQualia.exportWriteup'); break;
			case 'setKey': await vscode.commands.executeCommand('miniQualia.setApiKey'); break;
		}
	}

	private async handleUserMessage(text: string): Promise<void> {
		const userText = text.trim();
		if (!userText) { return; }
		if (this.busy) { this.postTranscript('system', 'Still working on the previous message...'); return; }
		const apiKey = await getApiKey(this.context);
		if (!apiKey) {
			this.postTranscript('system', 'No Anthropic API key set. Click "Set API Key" to enable the agent.');
			return;
		}

		this.record({ kind: 'transcript', role: 'you', text: userText });
		this.busy = true;
		this.abort = new AbortController();
		this.post({ type: 'busy', value: true });
		try {
			const cfg = vscode.workspace.getConfiguration('miniQualia');
			await runAgentTurn({
				apiKey,
				store: this.store,
				planner: createPlanner(apiKey, cfg.get<'auto' | 'deterministic'>('planner') ?? 'auto'),
				context: this.context,
				signal: this.abort.signal,
				history: this.history,
				userText,
				onAssistantStart: () => { this.currentAssistant = ''; this.post({ type: 'assistantStart' }); },
				onText: delta => { this.currentAssistant += delta; this.post({ type: 'assistantDelta', text: delta }); },
				onAssistantEnd: () => {
					this.post({ type: 'assistantEnd' });
					if (this.currentAssistant.trim()) {
						this.record({ kind: 'assistant', text: this.currentAssistant });
						void this.maybePostSlack(this.currentAssistant);
					}
				},
				onTool: (label, output) => { this.post({ type: 'tool', label, output }); this.record({ kind: 'tool', label, output }); },
				onUsage: (input, output) => {
					this.tokensIn += input;
					this.tokensOut += output;
					this.post({ type: 'usage', input: this.tokensIn, output: this.tokensOut });
				}
			});
		} catch (e) {
			if (this.abort?.signal.aborted) {
				this.postTranscript('system', 'Stopped.');
			} else {
				this.postTranscript('system', `Error: ${e instanceof Error ? e.message : String(e)}`);
			}
		} finally {
			this.busy = false;
			this.abort = undefined;
			this.post({ type: 'busy', value: false });
			void this.save();
		}
	}

	private async maybePostSlack(text: string): Promise<void> {
		const cfg = vscode.workspace.getConfiguration('miniQualia');
		const url = cfg.get<string>('slackWebhookUrl');
		if (!text.trim() || !url || cfg.get<string>('independence') !== 'infinity') { return; }
		try {
			await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `*MiniQualia*: ${text}` }) });
		} catch { /* best effort */ }
	}

	/** Sends a message into the agent as if typed by the user (used by commands). */
	async sendUserMessage(text: string): Promise<void> {
		this.post({ type: 'transcript', role: 'you', text });
		await this.handleUserMessage(text);
	}

	postTranscript(role: TranscriptRole, text: string): void {
		this.record({ kind: 'transcript', role, text });
		this.post({ type: 'transcript', role, text });
	}

	insertPrompt(text: string): void {
		this.post({ type: 'insertPrompt', text });
	}

	private clearTranscript(): void {
		this.transcript = [];
		this.history.length = 0;
		this.tokensIn = 0;
		this.tokensOut = 0;
		void this.save();
		this.post({ type: 'cleared' });
		this.post({ type: 'usage', input: 0, output: 0 });
	}

	private record(entry: TranscriptEntry): void {
		this.transcript.push(entry);
		if (this.transcript.length > 300) { this.transcript.shift(); }
	}

	private async save(): Promise<void> {
		await this.context.workspaceState.update(STATE_KEY, { history: this.history.slice(-60), transcript: this.transcript });
	}

	updateSummary(): void {
		const project = this.store.project;
		const tasks = project?.tasks ?? [];
		this.post({
			type: 'summary',
			data: {
				notebook: project?.notebookUri ? NOTEBOOK_FILENAME : null,
				counts: {
					total: tasks.length,
					completed: tasks.filter(t => t.status === 'completed').length,
					inProgress: tasks.filter(t => t.status === 'in_progress').length,
					failed: tasks.filter(t => t.status === 'failed').length
				},
				findings: project?.findings.length ?? 0,
				agents: (project?.agents ?? []).map(a => ({ label: agentLabel(a), status: a.status }))
			}
		});
	}

	private async updateKeyStatus(): Promise<void> {
		const cfg = vscode.workspace.getConfiguration('miniQualia');
		this.post({
			type: 'keyStatus',
			hasKey: await hasApiKey(this.context),
			model: cfg.get<string>('model') ?? MODELS[0],
			independence: cfg.get<string>('independence') ?? 'high',
			models: MODELS,
			independenceLevels: INDEPENDENCE
		});
	}

	private async updateSkills(): Promise<void> {
		const skills = await loadSkills(this.store.hasWorkspace ? this.store.workspaceUri : undefined);
		this.post({ type: 'skills', skills: skills.map(s => ({ name: s.name, description: s.description })) });
	}

	private post(message: object): void {
		this.view?.webview.postMessage(message);
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.js'));
		const csp = [`default-src 'none'`, `style-src ${webview.cspSource}`, `script-src 'nonce-${nonce}'`].join('; ');

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${styleUri}" rel="stylesheet">
	<title>MiniQualia Chat</title>
</head>
<body>
	<header class="mq-header">
		<span class="mq-badge">MiniQualia</span>
		<select id="model" class="mq-select" title="Model"></select>
		<select id="independence" class="mq-select" title="Independence — how much the agent asks vs. assumes"></select>
		<button id="clear" class="mq-iconbtn" title="Clear conversation">Clear</button>
	</header>

	<section class="mq-keybanner" id="keybanner" hidden>
		No Anthropic API key set. <button id="setKey" class="mq-link">Set API Key</button>
	</section>

	<section class="mq-summary" id="summary"></section>

	<section class="mq-transcript" id="transcript" aria-live="polite"></section>

	<div class="mq-suggest" id="suggest" hidden></div>

	<footer class="mq-composer">
		<textarea id="prompt" rows="3" placeholder="Ask MiniQualia to explore, build, or validate — / for skills. e.g. Explore this repo, set up the env, and run the tests."></textarea>
		<div class="mq-actions">
			<button id="send" class="mq-primary">Send</button>
			<button id="stop" class="mq-danger" hidden>Stop</button>
			<button id="plan">Plan</button>
			<button id="runReady">Run Ready</button>
			<button id="capture">Capture</button>
			<button id="export">Export</button>
			<span id="tokens" class="mq-tokens"></span>
		</div>
	</footer>

	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}
