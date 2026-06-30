/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { importKnowledge, validateFinding, validateUpstream } from '../knowledge';
import { MiniQualiaEvidenceSource } from '../model';
import { NOTEBOOK_FILENAME } from '../notebook';
import { MiniQualiaStore } from '../storage';
import { getNonce } from '../webview/nonce';

/**
 * The Knowledge view (secondary tree replaced by a rich webview): a searchable,
 * filterable, sortable list of claims with provenance, validation, and a
 * high-level toggle — Qualia's Knowledge sidebar.
 */
export class KnowledgeViewProvider implements vscode.WebviewViewProvider {

	static readonly viewType = 'miniQualia.knowledge';
	static current: KnowledgeViewProvider | undefined;

	private view?: vscode.WebviewView;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly store: MiniQualiaStore
	) {
		KnowledgeViewProvider.current = this;
		this.store.onDidChange(() => this.postClaims(), undefined, context.subscriptions);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
		view.webview.html = this.getHtml(view.webview);
		view.webview.onDidReceiveMessage((m: { type: string; id?: string }) => this.onMessage(m));
		view.onDidChangeVisibility(() => { if (view.visible) { this.postClaims(); } });
		this.postClaims();
	}

	refresh(): void {
		this.postClaims();
	}

	private async onMessage(message: { type: string; id?: string }): Promise<void> {
		switch (message.type) {
			case 'ready':
				this.postClaims();
				break;
			case 'openSource': {
				const finding = this.store.project?.findings.find(f => f.id === message.id);
				if (finding) {
					await vscode.commands.executeCommand('miniQualia.openFindingSource', finding);
				}
				break;
			}
			case 'validate': {
				if (message.id) {
					const r = await validateFinding(this.store, message.id);
					vscode.window.showInformationMessage(`MiniQualia: ${r.message}`);
				}
				break;
			}
			case 'validateUpstream': {
				if (message.id) {
					const r = await validateUpstream(this.store, message.id);
					vscode.window.showInformationMessage(`MiniQualia: ${r.message}`);
				}
				break;
			}
			case 'toggleHighLevel': {
				await this.store.mutate(p => {
					const f = p.findings.find(x => x.id === message.id);
					if (f) { f.highLevel = !f.highLevel; }
				});
				break;
			}
			case 'graph':
				await vscode.commands.executeCommand('miniQualia.openKnowledgeGraph');
				break;
			case 'import':
				await this.importFlow();
				break;
		}
	}

	private async importFlow(): Promise<void> {
		if (!this.store.project) {
			vscode.window.showInformationMessage('MiniQualia: start a research session first.');
			return;
		}
		const picks = await vscode.window.showOpenDialog({
			title: 'Import Knowledge',
			canSelectMany: false,
			filters: { Knowledge: ['md', 'json', 'txt'] }
		});
		if (picks?.[0]) {
			const created = await importKnowledge(this.store, picks[0]);
			vscode.window.showInformationMessage(`MiniQualia: imported ${created.length} claim(s).`);
		}
	}

	private postClaims(): void {
		const project = this.store.project;
		const claims = (project?.findings ?? []).map(f => ({
			id: f.id,
			claim: f.claim,
			kind: f.kind,
			highLevel: !!f.highLevel,
			stale: !!f.stale,
			metric: f.metric,
			taskId: f.taskId,
			related: f.relatedClaimIds ?? [],
			source: describeSource(f.source),
			createdAt: f.createdAt
		}));
		this.post({ type: 'claims', claims });
	}

	private post(message: object): void {
		this.view?.webview.postMessage(message);
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'knowledge.css'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'knowledge.js'));
		const csp = [`default-src 'none'`, `style-src ${webview.cspSource}`, `script-src 'nonce-${nonce}'`].join('; ');
		return /* html */ `<!DOCTYPE html>
<html lang="en"><head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<link href="${styleUri}" rel="stylesheet">
</head><body>
	<div class="k-toolbar">
		<input id="search" class="k-search" type="text" placeholder="Search claims...">
		<div class="k-rowtools">
			<select id="sort" class="k-select" title="Sort">
				<option value="newest">Newest</option>
				<option value="oldest">Oldest</option>
				<option value="key">Key first</option>
			</select>
			<button id="graph" class="k-iconbtn" title="Open Knowledge Graph">Graph</button>
			<button id="import" class="k-iconbtn" title="Import Knowledge">Import</button>
		</div>
		<div class="k-chips" id="chips">
			<button class="k-chip active" data-filter="all">All</button>
			<button class="k-chip" data-filter="captured">Captured</button>
			<button class="k-chip" data-filter="synthesized">Synthesized</button>
			<button class="k-chip" data-filter="key">Key</button>
			<button class="k-chip" data-filter="stale">Stale</button>
		</div>
	</div>
	<div id="list" class="k-list"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body></html>`;
	}
}

function describeSource(source: MiniQualiaEvidenceSource): string {
	switch (source.type) {
		case 'notebook-cell': return `${NOTEBOOK_FILENAME} · cell ${source.cellIndex ?? '?'}`;
		case 'file': return source.uri?.split('/').pop() ?? 'file';
		case 'terminal': return 'terminal';
		default: return 'manual';
	}
}
