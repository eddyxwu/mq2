/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { runNextTask, runReadyTasks } from './agentRunner';
import { loadSkills } from './context';
import { createProject, ensureSessionCore, planTasksCore } from './core';
import { buildKnowledgeMermaid } from './graph';
import { clearApiKey, hasApiKey, setApiKey } from './llm/apiKey';
import { MiniQualiaFinding, MiniQualiaSkill } from './model';
import { NOTEBOOK_FILENAME, openNotebook } from './notebook';
import { ResearchPlanner } from './planner';
import { MiniQualiaStore } from './storage';
import { ChatViewProvider } from './views/chatViewProvider';
import { TaskGraphPanel } from './webview/taskGraphPanel';
import { captureFindingInteractive, exportWriteup, WRITEUP_FILENAME } from './writeup';

/** The canonical demo prompt, offered as the default when planning. */
const DEMO_PROMPT = 'Compare three models on the iris dataset, identify the best model, explain errors, and produce a short writeup with evidence.';

/** Dependencies the command handlers need. */
export interface CommandDeps {
	store: MiniQualiaStore;
	context: vscode.ExtensionContext;
	/** Resolves the active planner (LLM when a key is set, else deterministic). */
	getPlanner: () => Promise<ResearchPlanner>;
	/** Forces the Skills tree to reload from disk. */
	refreshSkills: () => void;
	extensionUri: vscode.Uri;
	mermaidUri: vscode.Uri | undefined;
}

const MODELS = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'];

/** Registers every MiniQualia command. */
export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
	const { store, getPlanner, extensionUri, mermaidUri } = deps;

	const register = (id: string, handler: (...args: any[]) => unknown) =>
		context.subscriptions.push(vscode.commands.registerCommand(id, handler));

	register('miniQualia.newResearchSession', () => newResearchSession(store));
	register('miniQualia.openChat', () => openChat(store));
	register('miniQualia.planResearchTasks', (prompt?: string) => planResearchTasks(store, getPlanner, prompt));
	register('miniQualia.runNextTask', () => runNextTaskCommand(store));
	register('miniQualia.runReadyTasks', () => runReadyTasksCommand(store));
	register('miniQualia.captureFinding', () => captureFindingCommand(store));
	register('miniQualia.openTaskGraph', () => openTaskGraph(store, extensionUri, mermaidUri));
	register('miniQualia.exportWriteup', () => exportWriteupCommand(store));
	register('miniQualia.resetDemoState', () => resetDemoState(store));
	register('miniQualia.setApiKey', () => setApiKeyCommand(deps.context));
	register('miniQualia.clearApiKey', () => clearApiKeyCommand(deps.context));
	register('miniQualia.pickModel', () => pickModel());
	register('miniQualia.importSkills', () => importSkills(store, deps.refreshSkills));
	register('miniQualia.runAutonomously', () => runAutonomously(store, deps.context));
	register('miniQualia.openKnowledgeGraph', () => openKnowledgeGraph(store));
	register('miniQualia.openFindingSource', (finding: MiniQualiaFinding) => openFindingSource(finding));
	register('miniQualia.useSkill', (skill: MiniQualiaSkill) => useSkill(skill));
}

async function pickModel(): Promise<void> {
	const pick = await vscode.window.showQuickPick(MODELS, { title: 'MiniQualia: Default Claude Model', placeHolder: 'Select the model for chat and planning' });
	if (pick) {
		await vscode.workspace.getConfiguration('miniQualia').update('model', pick, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`MiniQualia: model set to ${pick}.`);
	}
}

async function importSkills(store: MiniQualiaStore, refreshSkills: () => void): Promise<void> {
	const skills = await loadSkills(store.hasWorkspace ? store.workspaceUri : undefined);
	const imported = skills.filter(s => s.source !== 'built-in');
	refreshSkills();
	await vscode.commands.executeCommand('miniQualia.skills.focus');
	vscode.window.showInformationMessage(`MiniQualia: ${skills.length} skills available (${imported.length} imported from .claude / Cursor).`);
}

async function runAutonomously(store: MiniQualiaStore, context: vscode.ExtensionContext): Promise<void> {
	if (!(await ensureSession(store))) {
		return;
	}
	if (!(await hasApiKey(context))) {
		vscode.window.showWarningMessage('MiniQualia: set an Anthropic API key first (MiniQualia: Set Anthropic API Key).');
		return;
	}
	await vscode.workspace.getConfiguration('miniQualia').update('independence', 'infinity', vscode.ConfigurationTarget.Global);
	const goal = await vscode.window.showInputBox({
		title: 'Run Autonomously (Infinity independence)',
		prompt: 'Describe the research goal. MiniQualia will work without asking, posting progress (and to Slack if configured).',
		value: store.project?.prompt ?? DEMO_PROMPT,
		ignoreFocusOut: true
	});
	if (!goal) {
		return;
	}
	await vscode.commands.executeCommand('miniQualia.chat.focus');
	await ChatViewProvider.current?.sendUserMessage(goal);
}

async function openKnowledgeGraph(store: MiniQualiaStore): Promise<void> {
	if (!(await ensureWorkspace(store))) {
		return;
	}
	if (!store.project || store.project.findings.length === 0) {
		vscode.window.showInformationMessage('MiniQualia: no claims captured yet.');
		return;
	}
	const md = ['# MiniQualia Knowledge Graph', '', '```mermaid', buildKnowledgeMermaid(store.project), '```', ''].join('\n');
	const dir = vscode.Uri.joinPath(store.workspaceUri, '.miniqualia');
	await vscode.workspace.fs.createDirectory(dir);
	const uri = vscode.Uri.joinPath(dir, 'knowledge-graph.md');
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(md));
	await openWriteup(uri);
}

/** Ensures a session + notebook, prompting to open a folder when none is open. */
async function ensureSession(store: MiniQualiaStore, prompt?: string): Promise<boolean> {
	if (await ensureSessionCore(store, prompt)) {
		return true;
	}
	await promptOpenFolder();
	return false;
}

async function promptOpenFolder(): Promise<void> {
	const choice = await vscode.window.showInformationMessage(
		'MiniQualia needs an open folder to store the notebook, session state, and writeup.',
		'Open Folder…'
	);
	if (choice === 'Open Folder…') {
		await vscode.commands.executeCommand('workbench.action.files.openFolder');
	}
}

async function ensureWorkspace(store: MiniQualiaStore): Promise<boolean> {
	if (!store.hasWorkspace) {
		await promptOpenFolder();
		return false;
	}
	return true;
}

async function newResearchSession(store: MiniQualiaStore): Promise<void> {
	if (store.project && store.project.tasks.length > 0) {
		const choice = await vscode.window.showWarningMessage(
			'A MiniQualia research session already exists.',
			{ modal: true, detail: 'Start a new session (replaces the current state) or keep the current one and just open its notebook.' },
			'Start New', 'Keep Current'
		);
		if (choice === undefined) {
			return;
		}
		if (choice === 'Start New') {
			await store.setProject(createProject());
		}
	}

	if (!(await ensureSession(store))) {
		return;
	}
	const uri = vscode.Uri.parse(store.project!.notebookUri!);
	await openNotebook(uri);
	await vscode.commands.executeCommand('workbench.view.extension.miniQualia');

	ChatViewProvider.current?.postTranscript('miniqualia', `New research session ready. Created and opened ${NOTEBOOK_FILENAME}.`);
	vscode.window.showInformationMessage(`MiniQualia: research session ready (${NOTEBOOK_FILENAME}).`);
}

async function openChat(store: MiniQualiaStore): Promise<void> {
	await vscode.commands.executeCommand('miniQualia.chat.focus');
	if (!store.project) {
		ChatViewProvider.current?.postTranscript('system', 'Ask a research question and I will plan a task graph, run notebook-grounded agents, and capture findings. Set an API key to enable the agent.');
	}
}

async function planResearchTasks(store: MiniQualiaStore, getPlanner: () => Promise<ResearchPlanner>, promptArg?: string): Promise<void> {
	if (!(await ensureSession(store))) {
		return;
	}

	let prompt = promptArg?.trim();
	if (!prompt) {
		prompt = await vscode.window.showInputBox({
			title: 'Plan Research Tasks',
			prompt: 'Describe the research question to plan.',
			value: store.project?.prompt ?? DEMO_PROMPT,
			ignoreFocusOut: true
		});
	}
	if (!prompt) {
		return;
	}

	const planner = await getPlanner();
	const plan = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'MiniQualia: planning research tasks…' },
		() => planTasksCore(store, planner, prompt!)
	);

	const summary = plan.tasks.map(t => `${t.id} ${t.title}${t.dependencies.length ? ` (depends on ${t.dependencies.join(', ')})` : ''}`).join('\n');
	ChatViewProvider.current?.postTranscript('miniqualia', `Planned ${plan.tasks.length} tasks across ${plan.agents.length} agents:\n${summary}`);
	await vscode.commands.executeCommand('miniQualia.tasks.focus');
}

async function runNextTaskCommand(store: MiniQualiaStore): Promise<void> {
	if (!(await ensureWorkspace(store))) {
		return;
	}
	if (!store.project) {
		vscode.window.showInformationMessage('MiniQualia: start a research session and plan tasks first.');
		return;
	}
	const result = await runNextTask(store);
	if (result.ran) {
		ChatViewProvider.current?.postTranscript('miniqualia', result.message);
		if (result.writeupUri) {
			await openWriteup(result.writeupUri);
		}
	} else {
		ChatViewProvider.current?.postTranscript('system', result.message);
		vscode.window.showInformationMessage(`MiniQualia: ${result.message}`);
	}
}

async function runReadyTasksCommand(store: MiniQualiaStore): Promise<void> {
	if (!(await ensureWorkspace(store))) {
		return;
	}
	if (!store.project) {
		vscode.window.showInformationMessage('MiniQualia: start a research session and plan tasks first.');
		return;
	}
	const result = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'MiniQualia: running ready tasks…' },
		() => runReadyTasks(store)
	);
	ChatViewProvider.current?.postTranscript(result.ran ? 'miniqualia' : 'system', result.message);
	if (result.writeupUri) {
		await openWriteup(result.writeupUri);
	} else if (!result.ran) {
		vscode.window.showInformationMessage(`MiniQualia: ${result.message}`);
	}
}

async function captureFindingCommand(store: MiniQualiaStore): Promise<void> {
	if (!(await ensureWorkspace(store))) {
		return;
	}
	if (!store.project) {
		vscode.window.showInformationMessage('MiniQualia: start a research session first.');
		return;
	}
	const finding = await captureFindingInteractive(store);
	if (finding) {
		ChatViewProvider.current?.postTranscript('miniqualia', `Captured ${finding.id}: ${finding.claim}`);
		await vscode.commands.executeCommand('miniQualia.knowledge.focus');
	}
}

function openTaskGraph(store: MiniQualiaStore, extensionUri: vscode.Uri, mermaidUri: vscode.Uri | undefined): void {
	if (!store.project) {
		vscode.window.showInformationMessage('MiniQualia: plan some tasks first.');
		return;
	}
	TaskGraphPanel.createOrShow(extensionUri, store, mermaidUri);
}

async function exportWriteupCommand(store: MiniQualiaStore): Promise<void> {
	if (!(await ensureWorkspace(store))) {
		return;
	}
	if (!store.project) {
		vscode.window.showInformationMessage('MiniQualia: start a research session first.');
		return;
	}
	const uri = await exportWriteup(store);
	await openWriteup(uri);
	ChatViewProvider.current?.postTranscript('miniqualia', `Exported ${WRITEUP_FILENAME}.`);
}

/** Opens the writeup in Markdown preview (renders the embedded Mermaid graph). */
async function openWriteup(uri: vscode.Uri): Promise<void> {
	try {
		await vscode.commands.executeCommand('markdown.showPreview', uri);
	} catch {
		await vscode.commands.executeCommand('vscode.open', uri);
	}
}

async function resetDemoState(store: MiniQualiaStore): Promise<void> {
	if (!(await ensureWorkspace(store))) {
		return;
	}
	const choice = await vscode.window.showWarningMessage(
		'Reset MiniQualia demo state?',
		{ modal: true, detail: `This clears the session and deletes ${NOTEBOOK_FILENAME} and ${WRITEUP_FILENAME} so you can re-run the demo from scratch.` },
		'Reset'
	);
	if (choice !== 'Reset') {
		return;
	}
	await store.setProject(undefined);
	await bestEffortDelete(vscode.Uri.joinPath(store.workspaceUri, NOTEBOOK_FILENAME));
	await bestEffortDelete(vscode.Uri.joinPath(store.workspaceUri, WRITEUP_FILENAME));
	ChatViewProvider.current?.postTranscript('system', 'Demo state reset.');
	vscode.window.showInformationMessage('MiniQualia: demo state reset.');
}

async function setApiKeyCommand(context: vscode.ExtensionContext): Promise<void> {
	const key = await setApiKey(context);
	if (key) {
		ChatViewProvider.current?.postTranscript('system', 'Anthropic API key saved. The agent is ready.');
		vscode.window.showInformationMessage('MiniQualia: Anthropic API key saved.');
	}
}

async function clearApiKeyCommand(context: vscode.ExtensionContext): Promise<void> {
	await clearApiKey(context);
	vscode.window.showInformationMessage('MiniQualia: stored Anthropic API key cleared.');
}

async function bestEffortDelete(uri: vscode.Uri): Promise<void> {
	try {
		await vscode.workspace.fs.delete(uri);
	} catch {
		// Nothing to delete.
	}
}

async function openFindingSource(finding: MiniQualiaFinding): Promise<void> {
	const source = finding?.source;
	if (!source) {
		return;
	}
	if (source.type === 'notebook-cell' && source.uri) {
		const uri = vscode.Uri.parse(source.uri);
		const doc = await vscode.workspace.openNotebookDocument(uri);
		const index = Math.min(source.cellIndex ?? 0, Math.max(0, doc.cellCount - 1));
		await vscode.window.showNotebookDocument(doc, {
			preview: false,
			selections: [new vscode.NotebookRange(index, index + 1)]
		});
		return;
	}
	if (source.type === 'file' && source.uri) {
		await openWriteup(vscode.Uri.parse(source.uri));
		return;
	}
	vscode.window.showInformationMessage(`MiniQualia: ${finding.id} has no openable source (${source.type}).`);
}

async function useSkill(skill: MiniQualiaSkill): Promise<void> {
	await vscode.commands.executeCommand('miniQualia.chat.focus');
	ChatViewProvider.current?.insertPrompt(skill.template);
	ChatViewProvider.current?.postTranscript('system', `Inserted ${skill.slashCommand} template into the prompt.`);
}
