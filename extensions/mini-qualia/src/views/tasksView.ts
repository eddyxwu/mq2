/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { statusLabel } from '../graph';
import { MiniQualiaTask, TaskStatus } from '../model';
import { MiniQualiaStore } from '../storage';
import { agentLabel } from '../writeup';

type TaskNode = StatusGroupItem | TaskItem;

/** Order in which status groups appear in the tree. */
const STATUS_ORDER: TaskStatus[] = ['in_progress', 'planned', 'paused_by_user', 'completed', 'failed', 'cancelled'];

/** Tree view of tasks grouped by status. */
export class TasksTreeProvider implements vscode.TreeDataProvider<TaskNode>, vscode.Disposable {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly _subscription: vscode.Disposable;

	constructor(private readonly store: MiniQualiaStore) {
		this._subscription = store.onDidChange(() => this._onDidChangeTreeData.fire());
	}

	getTreeItem(element: TaskNode): vscode.TreeItem {
		return element;
	}

	getChildren(element?: TaskNode): TaskNode[] {
		const project = this.store.project;
		if (!project) {
			return [];
		}
		if (!element) {
			return STATUS_ORDER
				.map(status => ({ status, tasks: project.tasks.filter(t => t.status === status) }))
				.filter(group => group.tasks.length > 0)
				.map(group => new StatusGroupItem(group.status, group.tasks.length));
		}
		if (element instanceof StatusGroupItem) {
			return project.tasks
				.filter(t => t.status === element.status)
				.map(task => new TaskItem(task, agentLabel(project.agents.find(a => a.id === task.assignedAgentId))));
		}
		return [];
	}

	dispose(): void {
		this._subscription.dispose();
		this._onDidChangeTreeData.dispose();
	}
}

class StatusGroupItem extends vscode.TreeItem {
	constructor(readonly status: TaskStatus, count: number) {
		super(`${statusLabel(status).toUpperCase()} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
		this.iconPath = statusIcon(status);
		this.contextValue = 'miniQualia.taskGroup';
	}
}

class TaskItem extends vscode.TreeItem {
	constructor(task: MiniQualiaTask, assignedLabel: string) {
		super(`${task.id} ${task.title}`, vscode.TreeItemCollapsibleState.None);
		const deps = task.dependencies.length ? `depends on ${task.dependencies.join(', ')}` : 'no dependencies';
		this.description = `${assignedLabel} · ${deps}`;
		this.iconPath = statusIcon(task.status);
		this.contextValue = 'miniQualia.task';
		const tooltip = new vscode.MarkdownString();
		tooltip.appendMarkdown(`**${task.id} ${task.title}**\n\n`);
		tooltip.appendMarkdown(`${task.objective}\n\n`);
		tooltip.appendMarkdown(`- Status: \`${statusLabel(task.status)}\`\n`);
		tooltip.appendMarkdown(`- Agent: ${assignedLabel}\n`);
		tooltip.appendMarkdown(`- Depends on: ${task.dependencies.join(', ') || '—'}\n`);
		if (task.requiredVars?.length) {
			tooltip.appendMarkdown(`- Q_VARS: \`${task.requiredVars.join('`, `')}\`\n`);
		}
		if (task.cellIndices?.length) {
			tooltip.appendMarkdown(`- Notebook cells: ${task.cellIndices.join(', ')}\n`);
		}
		this.tooltip = tooltip;
	}
}

function statusIcon(status: TaskStatus): vscode.ThemeIcon {
	switch (status) {
		case 'in_progress': return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
		case 'completed': return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
		case 'failed': return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
		case 'cancelled': return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.gray'));
		case 'paused_by_user': return new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('charts.yellow'));
		default: return new vscode.ThemeIcon('circle-outline');
	}
}
