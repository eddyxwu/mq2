/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { buildMermaid, statusLabel } from './graph';
import { MiniQualiaAgent, MiniQualiaEvidenceSource, MiniQualiaFinding, MiniQualiaProject, MiniQualiaTask } from './model';
import { NOTEBOOK_FILENAME } from './notebook';
import { createFinding, MiniQualiaStore } from './storage';

/** The exported writeup filename, written to the workspace root. */
export const WRITEUP_FILENAME = 'miniqualia-writeup.md';

/** Parameters for recording a new finding. */
export interface RecordFindingParams {
	kind: MiniQualiaFinding['kind'];
	claim: string;
	summary?: string;
	taskId?: string;
	source: MiniQualiaEvidenceSource;
	highLevel?: boolean;
	metric?: number;
	relatedClaimIds?: string[];
}

/** Renders an agent as `A-1 Research Lead`. */
export function agentLabel(agent: MiniQualiaAgent | undefined): string {
	return agent ? `${agent.id} ${agent.name}` : 'unassigned';
}

/**
 * Records a finding in the session, links it back to its task, and returns it.
 */
export async function recordFinding(store: MiniQualiaStore, params: RecordFindingParams): Promise<MiniQualiaFinding> {
	const id = store.nextFindingId();
	const finding = createFinding({ id, ...params });
	await store.mutate(project => {
		project.findings.push(finding);
		if (params.taskId) {
			const task = project.tasks.find(t => t.id === params.taskId);
			if (task) {
				task.resultFindingIds = [...(task.resultFindingIds ?? []), id];
			}
		}
	});
	return finding;
}

/**
 * Interactive "Capture Finding" flow. Prefers to ground the finding in the most
 * relevant completed notebook cell (the comparison cell, if present) so the
 * captured claim carries real provenance.
 */
export async function captureFindingInteractive(store: MiniQualiaStore): Promise<MiniQualiaFinding | undefined> {
	const project = store.project;
	if (!project) {
		return undefined;
	}

	const sourceTask = pickEvidenceTask(project);
	const defaultClaim = sourceTask ? defaultClaimForTask(sourceTask) : 'Manual finding captured in MiniQualia.';

	const claim = await vscode.window.showInputBox({
		title: 'Capture Finding',
		prompt: 'State the claim. It will be linked to its notebook evidence.',
		value: defaultClaim,
		ignoreFocusOut: true
	});
	if (!claim) {
		return undefined;
	}
	return captureFindingGrounded(store, claim);
}

/**
 * Records a finding for the given claim, grounding it in the most relevant
 * completed notebook cell when one exists. Used by the agentic chat's
 * `capture_finding` tool (no UI prompt).
 */
export async function captureFindingGrounded(store: MiniQualiaStore, claim: string, opts?: { highLevel?: boolean; metric?: number }): Promise<MiniQualiaFinding> {
	const project = store.project!;
	const sourceTask = pickEvidenceTask(project);

	let source: MiniQualiaEvidenceSource;
	let kind: MiniQualiaFinding['kind'];
	if (sourceTask && project.notebookUri && sourceTask.cellIndices?.length) {
		source = {
			type: 'notebook-cell',
			uri: project.notebookUri,
			cellIndex: sourceTask.cellIndices[sourceTask.cellIndices.length - 1]
		};
		kind = 'notebook-captured';
	} else {
		source = { type: 'manual' };
		kind = 'synthesized';
	}

	return recordFinding(store, {
		kind,
		claim,
		summary: kind === 'synthesized'
			? 'Synthesized claim. In production this would be validated against the kernel\'s actual outputs.'
			: 'Captured from a generated notebook cell.',
		taskId: sourceTask?.id,
		source,
		highLevel: opts?.highLevel,
		metric: opts?.metric
	});
}

/** Picks the best task to anchor a captured finding: prefer the comparison task. */
function pickEvidenceTask(project: MiniQualiaProject): MiniQualiaTask | undefined {
	const completedWithCells = project.tasks.filter(t => t.status === 'completed' && t.cellIndices?.length);
	return completedWithCells.find(t => t.id === 'T-5') ?? completedWithCells[completedWithCells.length - 1];
}

function defaultClaimForTask(task: MiniQualiaTask): string {
	if (task.id === 'T-5') {
		return 'Logistic regression, random forest, and SVM all reach near-ceiling held-out accuracy on iris; the top scorer is recorded in best_model / best_accuracy.';
	}
	return `Finding from ${task.id}: ${task.objective}`;
}

/**
 * Writes `miniqualia-writeup.md` to the workspace root and returns its uri. The
 * writeup embeds a Mermaid task graph and links every finding to its evidence.
 */
export async function exportWriteup(store: MiniQualiaStore): Promise<vscode.Uri> {
	const project = store.project;
	if (!project) {
		throw new Error('No active research session.');
	}

	const uri = vscode.Uri.joinPath(store.workspaceUri, WRITEUP_FILENAME);
	const md = renderWriteup(project);
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(md));
	return uri;
}

function renderWriteup(project: MiniQualiaProject): string {
	const agentById = new Map(project.agents.map(a => [a.id, a]));
	const out: string[] = [];

	out.push('# MiniQualia Research Writeup');
	out.push('');
	out.push(`_Generated by MiniQualia on ${new Date().toISOString()}_`);
	out.push('');

	out.push('## Objective');
	out.push('');
	out.push(project.prompt?.trim() || project.name);
	out.push('');

	out.push('## Agents');
	out.push('');
	for (const agent of project.agents) {
		out.push(`- **${agent.id} ${agent.name}** — independence: \`${agent.independence}\` — tasks: ${agent.taskIds.join(', ') || '—'}`);
	}
	out.push('');

	out.push('## Task Graph');
	out.push('');
	out.push('```mermaid');
	out.push(buildMermaid(project));
	out.push('```');
	out.push('');
	for (const task of project.tasks) {
		const agent = agentById.get(task.assignedAgentId);
		const deps = task.dependencies.length ? task.dependencies.join(', ') : '—';
		out.push(`- **${task.id} ${task.title}** — _${statusLabel(task.status)}_ — agent ${agentLabel(agent)} — depends on: ${deps}`);
	}
	out.push('');

	out.push('## Findings');
	out.push('');
	if (project.findings.length === 0) {
		out.push('_No findings captured yet._');
		out.push('');
	} else {
		for (const finding of project.findings) {
			out.push(`### ${finding.highLevel ? '* ' : ''}${finding.id} — ${finding.claim}`);
			out.push('');
			out.push(`- Kind: \`${finding.kind}\`${finding.highLevel ? ' · **key finding**' : ''}`);
			if (finding.metric !== undefined) {
				out.push(`- Metric: ${finding.metric}`);
			}
			if (finding.taskId) {
				out.push(`- Task: ${finding.taskId}`);
			}
			out.push(`- Source: ${describeSource(finding.source)}`);
			out.push(`- Captured: ${finding.createdAt}`);
			if (finding.summary) {
				out.push('');
				out.push(finding.summary);
			}
			out.push('');
		}
	}

	out.push('## Notebook');
	out.push('');
	out.push(`[${NOTEBOOK_FILENAME}](${NOTEBOOK_FILENAME})`);
	out.push('');

	out.push('## Q_VARS');
	out.push('');
	out.push('Findings are grounded in named notebook variables that flow between tasks — the MiniQualia analogue of Qualia\'s Q_VARS.');
	out.push('');
	const qvars = project.qvars && Object.keys(project.qvars).length ? project.qvars : undefined;
	if (qvars) {
		out.push('Measured from executed notebook cells:');
		out.push('');
		out.push('```json');
		out.push(JSON.stringify(qvars, undefined, 2));
		out.push('```');
	} else {
		out.push('Expected variables: `results`, `best_model`, `best_accuracy` (run with a kernel to capture measured values).');
	}
	out.push('');

	out.push('## Notes');
	out.push('');
	out.push('This is a MiniQualia prototype built as a VS Code OSS extension. Notebook-captured findings reference the generated cells that produced them; in production they would be validated against the kernel\'s actual outputs.');
	out.push('');

	return out.join('\n');
}

function describeSource(source: MiniQualiaEvidenceSource): string {
	switch (source.type) {
		case 'notebook-cell':
			return `${NOTEBOOK_FILENAME}, cell ${source.cellIndex ?? '?'}`;
		case 'file':
			return source.uri ? source.uri : 'file';
		case 'terminal':
			return source.command ? `terminal: \`${source.command}\`` : 'terminal';
		default:
			return 'manual entry';
	}
}
