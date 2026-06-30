/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { buildMermaid, statusLabel } from '../graph';
import { MiniQualiaProject, MiniQualiaTask } from '../model';
import { MiniQualiaStore } from '../storage';
import { agentLabel } from '../writeup';
import { getNonce } from './nonce';

/**
 * The task-graph webview. Renders the DAG with Mermaid (the same engine that
 * ships with VS Code's Markdown preview) and lists detail cards beneath it,
 * which also serve as a fallback if the Mermaid script is unavailable.
 */
export class TaskGraphPanel {

	private static readonly viewType = 'miniQualia.taskGraph';
	static current: TaskGraphPanel | undefined;

	private readonly _panel: vscode.WebviewPanel;
	private readonly _disposables: vscode.Disposable[] = [];

	static createOrShow(extensionUri: vscode.Uri, store: MiniQualiaStore, mermaidUri: vscode.Uri | undefined): TaskGraphPanel {
		const column = vscode.ViewColumn.Beside;
		if (TaskGraphPanel.current) {
			TaskGraphPanel.current._panel.reveal(column);
			TaskGraphPanel.current.render();
			return TaskGraphPanel.current;
		}
		const roots = [vscode.Uri.joinPath(extensionUri, 'media')];
		if (mermaidUri) {
			roots.push(vscode.Uri.joinPath(mermaidUri, '..'));
		}
		const panel = vscode.window.createWebviewPanel(
			TaskGraphPanel.viewType,
			'MiniQualia Task Graph',
			column,
			{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: roots }
		);
		TaskGraphPanel.current = new TaskGraphPanel(panel, store, mermaidUri);
		return TaskGraphPanel.current;
	}

	private constructor(panel: vscode.WebviewPanel, private readonly store: MiniQualiaStore, private readonly mermaidUri: vscode.Uri | undefined) {
		this._panel = panel;
		this._panel.onDidDispose(() => this.dispose(), undefined, this._disposables);
		this.store.onDidChange(() => this.render(), undefined, this._disposables);
		this.render();
	}

	/** Rebuilds the webview HTML from the current session. */
	render(): void {
		this._panel.webview.html = this.getHtml(this._panel.webview);
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const project = this.store.project;
		const mermaidScript = this.mermaidUri
			? `<script nonce="${nonce}" src="${webview.asWebviewUri(this.mermaidUri)}"></script>`
			: '';

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}' 'unsafe-eval'`,
			`font-src ${webview.cspSource}`
		].join('; ');

		if (!project || project.tasks.length === 0) {
			return this.shell(csp, '', '<p class="mq-empty">No tasks planned yet. Run "MiniQualia: Plan Research Tasks" to generate a DAG.</p>', nonce, '');
		}

		const mermaidDef = buildMermaid(project);
		const graphBlock = mermaidScript
			? `<div class="mq-mermaid"><pre id="graph">Rendering graph...</pre></div>`
			: `<p class="mq-empty">Mermaid is unavailable; showing dependency cards only.</p>`;

		const cards = project.tasks.map(task => this.cardHtml(task, project)).join('\n');

		const initScript = mermaidScript
			? `<script nonce="${nonce}">
				const def = ${JSON.stringify(mermaidDef)};
				try {
					mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'dark' });
					mermaid.render('mqGraphSvg', def).then(function (res) {
						document.getElementById('graph').outerHTML = res.svg;
					}).catch(function (err) {
						document.getElementById('graph').textContent = String(err);
					});
				} catch (err) {
					document.getElementById('graph').textContent = String(err);
				}
			</script>`
			: '';

		return this.shell(csp, mermaidScript, `${graphBlock}<div class="mq-cards">${cards}</div>`, nonce, initScript);
	}

	private cardHtml(task: MiniQualiaTask, project: MiniQualiaProject): string {
		const agent = agentLabel(project.agents.find(a => a.id === task.assignedAgentId));
		const deps = task.dependencies.length ? task.dependencies.join(', ') : '—';
		return `<div class="mq-task" data-status="${task.status}">
			<div class="mq-task-head">
				<span class="mq-task-id">${escapeHtml(task.id)}</span>
				<span class="mq-status">${escapeHtml(statusLabel(task.status))}</span>
			</div>
			<div class="mq-task-title">${escapeHtml(task.title)}</div>
			<div class="mq-task-meta">Agent: ${escapeHtml(agent)}</div>
			<div class="mq-task-meta">Depends on: ${escapeHtml(deps)}</div>
		</div>`;
	}

	private shell(csp: string, mermaidScript: string, body: string, nonce: string, initScript: string): string {
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>MiniQualia Task Graph</title>
	<style nonce="${nonce}">
		body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
		h1 { font-size: 15px; margin: 0 0 12px; }
		.mq-empty { color: var(--vscode-descriptionForeground); }
		.mq-mermaid { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 12px; margin-bottom: 16px; overflow: auto; background: var(--vscode-editorWidget-background); }
		.mq-mermaid svg { max-width: 100%; height: auto; }
		.mq-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
		.mq-task { border: 1px solid var(--vscode-panel-border); border-left-width: 4px; border-radius: 6px; padding: 10px; background: var(--vscode-editorWidget-background); }
		.mq-task[data-status="completed"] { border-left-color: var(--vscode-charts-green); }
		.mq-task[data-status="in_progress"] { border-left-color: var(--vscode-charts-blue); }
		.mq-task[data-status="planned"] { border-left-color: var(--vscode-descriptionForeground); }
		.mq-task[data-status="failed"] { border-left-color: var(--vscode-charts-red); }
		.mq-task[data-status="paused_by_user"] { border-left-color: var(--vscode-charts-yellow); }
		.mq-task-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
		.mq-task-id { font-weight: 700; }
		.mq-status { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
		.mq-task-title { font-weight: 600; margin-bottom: 6px; }
		.mq-task-meta { font-size: 12px; color: var(--vscode-descriptionForeground); }
	</style>
</head>
<body>
	<h1>Task Graph</h1>
	${body}
	${mermaidScript}
	${initScript}
</body>
</html>`;
	}

	dispose(): void {
		TaskGraphPanel.current = undefined;
		this._panel.dispose();
		while (this._disposables.length) {
			this._disposables.pop()?.dispose();
		}
	}
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
