/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { MiniQualiaAgent } from '../model';
import { MiniQualiaStore } from '../storage';

/** Tree view of research agents and their status. */
export class AgentsTreeProvider implements vscode.TreeDataProvider<AgentItem>, vscode.Disposable {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly _subscription: vscode.Disposable;

	constructor(private readonly store: MiniQualiaStore) {
		this._subscription = store.onDidChange(() => this._onDidChangeTreeData.fire());
	}

	getTreeItem(element: AgentItem): vscode.TreeItem {
		return element;
	}

	getChildren(): AgentItem[] {
		const project = this.store.project;
		return project ? project.agents.map(agent => new AgentItem(agent)) : [];
	}

	dispose(): void {
		this._subscription.dispose();
		this._onDidChangeTreeData.dispose();
	}
}

class AgentItem extends vscode.TreeItem {
	constructor(agent: MiniQualiaAgent) {
		super(`${agent.id} ${agent.name}`, vscode.TreeItemCollapsibleState.None);
		this.description = `${agent.status} · ${agent.independence}`;
		this.iconPath = statusIcon(agent.status);
		this.contextValue = 'miniQualia.agent';
		const tooltip = new vscode.MarkdownString();
		tooltip.appendMarkdown(`**${agent.id} ${agent.name}**\n\n`);
		tooltip.appendMarkdown(`- Status: \`${agent.status}\`\n`);
		tooltip.appendMarkdown(`- Independence: \`${agent.independence}\`\n`);
		tooltip.appendMarkdown(`- Assigned tasks (${agent.taskIds.length}): ${agent.taskIds.join(', ') || '—'}`);
		this.tooltip = tooltip;
	}
}

function statusIcon(status: MiniQualiaAgent['status']): vscode.ThemeIcon {
	switch (status) {
		case 'working': return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
		case 'blocked': return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.yellow'));
		case 'done': return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
		default: return new vscode.ThemeIcon('person');
	}
}
