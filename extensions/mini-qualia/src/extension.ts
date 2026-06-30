/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { getApiKey } from './llm/apiKey';
import { createPlanner } from './planner';
import { MiniQualiaStore } from './storage';
import { AgentsTreeProvider } from './views/agentsView';
import { ChatViewProvider } from './views/chatViewProvider';
import { KnowledgeViewProvider } from './views/knowledgeViewProvider';
import { SkillsTreeProvider } from './views/skillsView';
import { TasksTreeProvider } from './views/tasksView';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const store = new MiniQualiaStore(vscode.workspace.workspaceFolders?.[0]);
	context.subscriptions.push(store);
	await store.load();

	// Tree views (activity bar, left).
	const agents = new AgentsTreeProvider(store);
	const tasks = new TasksTreeProvider(store);
	const skills = new SkillsTreeProvider(store);
	const knowledge = new KnowledgeViewProvider(context, store);
	context.subscriptions.push(
		agents, tasks, skills,
		vscode.window.registerTreeDataProvider('miniQualia.agents', agents),
		vscode.window.registerTreeDataProvider('miniQualia.tasks', tasks),
		vscode.window.registerWebviewViewProvider(KnowledgeViewProvider.viewType, knowledge, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.window.registerTreeDataProvider('miniQualia.skills', skills)
	);

	// Agentic chat (secondary side bar, right).
	const chat = new ChatViewProvider(context, store);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);

	// Context keys drive the views' welcome content.
	const updateContextKeys = () => {
		vscode.commands.executeCommand('setContext', 'miniQualia.hasProject', !!store.project);
		vscode.commands.executeCommand('setContext', 'miniQualia.hasTasks', (store.project?.tasks.length ?? 0) > 0);
	};
	updateContextKeys();
	context.subscriptions.push(store.onDidChange(updateContextKeys));

	const getPlanner = async () => {
		const apiKey = await getApiKey(context);
		const mode = vscode.workspace.getConfiguration('miniQualia').get<'auto' | 'deterministic'>('planner') ?? 'auto';
		return createPlanner(apiKey, mode);
	};

	registerCommands(context, {
		store,
		context,
		getPlanner,
		refreshSkills: () => skills.refresh(),
		extensionUri: context.extensionUri,
		mermaidUri: await resolveMermaidUri(context.extensionUri)
	});
}

/**
 * Locates the Mermaid bundle that already ships with VS Code's Markdown
 * tooling so the task-graph webview can render the DAG without vendoring a copy.
 * Returns undefined when it cannot be found (the webview then falls back to
 * dependency cards).
 */
async function resolveMermaidUri(extensionUri: vscode.Uri): Promise<vscode.Uri | undefined> {
	const candidates = [
		vscode.Uri.joinPath(extensionUri, '..', 'markdown-language-features', 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
		vscode.Uri.joinPath(extensionUri, '..', 'mermaid-markdown-features', 'node_modules', 'mermaid', 'dist', 'mermaid.min.js')
	];
	for (const candidate of candidates) {
		try {
			await vscode.workspace.fs.stat(candidate);
			return candidate;
		} catch {
			// Try the next candidate.
		}
	}
	return undefined;
}

export function deactivate(): void {
	// Disposables are handled via context.subscriptions.
}
