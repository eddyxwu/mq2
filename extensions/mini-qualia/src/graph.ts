/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MiniQualiaProject, MiniQualiaTask, TaskStatus } from './model';

/**
 * Builds a Mermaid `flowchart` definition for the task DAG. Reused by both the
 * task-graph webview and the exported writeup so the visualization is rendered
 * by Mermaid (already shipped with VS Code's Markdown preview) rather than a
 * hand-rolled graph engine.
 */
export function buildMermaid(project: MiniQualiaProject): string {
	const lines: string[] = ['flowchart TD'];

	for (const task of project.tasks) {
		const label = `${task.id} ${escapeLabel(task.title)}`;
		lines.push(`    ${nodeId(task.id)}["${label}"]`);
	}

	for (const task of project.tasks) {
		for (const dep of task.dependencies) {
			lines.push(`    ${nodeId(dep)} --> ${nodeId(task.id)}`);
		}
	}

	// Status-driven styling.
	lines.push('    classDef planned fill:#3a3d41,stroke:#888,color:#fff;');
	lines.push('    classDef in_progress fill:#1f6feb,stroke:#58a6ff,color:#fff;');
	lines.push('    classDef completed fill:#238636,stroke:#3fb950,color:#fff;');
	lines.push('    classDef failed fill:#da3633,stroke:#f85149,color:#fff;');
	lines.push('    classDef cancelled fill:#6e7681,stroke:#8b949e,color:#fff;');
	lines.push('    classDef paused_by_user fill:#9e6a03,stroke:#d29922,color:#fff;');

	for (const task of project.tasks) {
		lines.push(`    class ${nodeId(task.id)} ${task.status};`);
	}

	return lines.join('\n');
}

/**
 * Builds a Mermaid `flowchart` for the Knowledge graph: claims linked to the
 * tasks that produced them and to upstream claims they build on.
 */
export function buildKnowledgeMermaid(project: MiniQualiaProject): string {
	const lines: string[] = ['flowchart LR'];
	if (project.findings.length === 0) {
		lines.push('    empty["No claims captured yet"]');
		return lines.join('\n');
	}

	const taskIds = new Set<string>();
	for (const f of project.findings) {
		const label = `${f.highLevel ? '* ' : ''}${f.id} ${escapeLabel(f.claim).slice(0, 48)}`;
		lines.push(`    ${nodeId(f.id)}["${label}"]`);
		if (f.taskId) {
			taskIds.add(f.taskId);
		}
	}
	for (const id of taskIds) {
		const task = project.tasks.find(t => t.id === id);
		lines.push(`    ${nodeId(id)}(["${id} ${escapeLabel(task?.title ?? '')}"])`);
	}
	for (const f of project.findings) {
		if (f.taskId) {
			lines.push(`    ${nodeId(f.id)} -.->|from| ${nodeId(f.taskId)}`);
		}
		for (const rel of f.relatedClaimIds ?? []) {
			lines.push(`    ${nodeId(rel)} --> ${nodeId(f.id)}`);
		}
	}

	lines.push('    classDef captured fill:#238636,stroke:#3fb950,color:#fff;');
	lines.push('    classDef synthesized fill:#9e6a03,stroke:#d29922,color:#fff;');
	lines.push('    classDef stale fill:#da3633,stroke:#f85149,color:#fff;');
	lines.push('    classDef key fill:#bb8009,stroke:#e3b341,color:#fff;');
	for (const f of project.findings) {
		const cls = f.stale ? 'stale' : f.highLevel ? 'key' : f.kind === 'notebook-captured' ? 'captured' : 'synthesized';
		lines.push(`    class ${nodeId(f.id)} ${cls};`);
	}
	return lines.join('\n');
}

/** Mermaid node ids must avoid hyphens; map `T-1` -> `T_1`. */
function nodeId(taskId: string): string {
	return taskId.replace(/-/g, '_');
}

function escapeLabel(text: string): string {
	return text.replace(/"/g, '\'');
}

/** Human-readable status label. */
export function statusLabel(status: TaskStatus): string {
	switch (status) {
		case 'in_progress': return 'in progress';
		case 'paused_by_user': return 'paused by user';
		default: return status;
	}
}

/** Returns true when every dependency of the task is completed. */
export function isUnblocked(task: MiniQualiaTask, project: MiniQualiaProject): boolean {
	return task.dependencies.every(depId => project.tasks.find(t => t.id === depId)?.status === 'completed');
}
