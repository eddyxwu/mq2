/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { LoadedSkill, loadSkills } from '../context';
import { MiniQualiaStore } from '../storage';

/** Tree view of Skills (built-in plus imported from .claude / Cursor). */
export class SkillsTreeProvider implements vscode.TreeDataProvider<SkillItem>, vscode.Disposable {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly _subscription: vscode.Disposable;

	constructor(private readonly store: MiniQualiaStore) {
		this._subscription = store.onDidChange(() => this._onDidChangeTreeData.fire());
	}

	/** Forces a reload of skills from disk (used after import). */
	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: SkillItem): vscode.TreeItem {
		return element;
	}

	async getChildren(): Promise<SkillItem[]> {
		const skills = await loadSkills(this.store.hasWorkspace ? this.store.workspaceUri : undefined);
		return skills.map(skill => new SkillItem(skill));
	}

	dispose(): void {
		this._subscription.dispose();
		this._onDidChangeTreeData.dispose();
	}
}

class SkillItem extends vscode.TreeItem {
	constructor(skill: LoadedSkill) {
		super(skill.slashCommand, vscode.TreeItemCollapsibleState.None);
		this.description = `${skill.name} · ${skill.source}`;
		this.iconPath = new vscode.ThemeIcon(skill.autoInvoke ? 'symbol-event' : 'symbol-method');
		this.contextValue = 'miniQualia.skill';
		// Selecting a skill inserts its instructions into chat.
		this.command = {
			command: 'miniQualia.useSkill',
			title: 'Use Skill in Chat',
			arguments: [{ id: skill.name, name: skill.name, slashCommand: skill.slashCommand, description: skill.description, template: skill.instructions }]
		};
		const tooltip = new vscode.MarkdownString();
		tooltip.appendMarkdown(`**${skill.slashCommand}** — ${skill.description}\n\n`);
		tooltip.appendMarkdown(`_source: ${skill.source}${skill.autoInvoke ? ' · agent-triggerable' : ' · manual'}_\n\n`);
		tooltip.appendCodeblock(skill.instructions.slice(0, 800), 'text');
		this.tooltip = tooltip;
	}
}
