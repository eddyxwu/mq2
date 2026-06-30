/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { isUnblocked } from './graph';
import { MiniQualiaAgent, MiniQualiaFinding, MiniQualiaProject, MiniQualiaTask } from './model';
import { appendCells, cellsForTask, ensureNotebook, executeCells, readCellResult, writeQvars } from './notebook';
import { MiniQualiaStore } from './storage';
import { agentLabel, exportWriteup, recordFinding } from './writeup';

/** Outcome of attempting to run one or more tasks. */
export interface RunResult {
	ran: boolean;
	task?: MiniQualiaTask;
	message: string;
	writeupUri?: vscode.Uri;
	findings: MiniQualiaFinding[];
}

const TERMINAL_NAME = 'MiniQualia Agent';

/** Once execution fails (no kernel), stop retrying for the rest of the session. */
let executionUnavailable = false;
let hintedNoKernel = false;

function executionEnabled(): boolean {
	return vscode.workspace.getConfiguration('miniQualia').get<boolean>('enableNotebookExecution') !== false;
}

function maxParallel(): number {
	return Math.max(1, vscode.workspace.getConfiguration('miniQualia').get<number>('maxParallelAgents') ?? 3);
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Runs the next unblocked planned task (single step).
 */
export async function runNextTask(store: MiniQualiaStore): Promise<RunResult> {
	const project = store.project;
	if (!project) {
		return { ran: false, message: 'No active research session. Start one first.', findings: [] };
	}
	const next = project.tasks.find(t => t.status === 'planned' && isUnblocked(t, project));
	if (!next) {
		return { ran: false, message: noReadyMessage(project), findings: [] };
	}
	return runTask(store, next.id);
}

/**
 * Runs every currently-unblocked task concurrently (bounded by
 * `miniQualia.maxParallelAgents`), then repeats wave by wave until the DAG is
 * drained. Mirrors Qualia spawning multiple agents to work in parallel. Notebook
 * writes and kernel execution are serialized internally (one kernel), so the
 * parallelism is in agent orchestration.
 */
export async function runReadyTasks(store: MiniQualiaStore): Promise<RunResult> {
	const project = store.project;
	if (!project) {
		return { ran: false, message: 'No active research session. Start one first.', findings: [] };
	}

	const findings: MiniQualiaFinding[] = [];
	let writeupUri: vscode.Uri | undefined;
	let count = 0;

	for (; ;) {
		const current = store.project;
		if (!current) {
			break;
		}
		const ready = current.tasks.filter(t => t.status === 'planned' && isUnblocked(t, current));
		if (ready.length === 0) {
			break;
		}
		const wave = ready.slice(0, maxParallel());
		const results = await Promise.all(wave.map(t => runTask(store, t.id)));
		for (const r of results) {
			count += r.ran ? 1 : 0;
			findings.push(...r.findings);
			writeupUri = r.writeupUri ?? writeupUri;
		}
	}

	if (count === 0) {
		return { ran: false, message: noReadyMessage(store.project ?? project), findings: [] };
	}
	return {
		ran: true,
		message: `Ran ${count} task(s) across the DAG.${findings.length ? ` Captured ${findings.map(f => f.id).join(', ')}.` : ''}`,
		writeupUri,
		findings
	};
}

function noReadyMessage(project: MiniQualiaProject): string {
	const remaining = project.tasks.filter(t => t.status === 'planned');
	return remaining.length
		? `No unblocked task to run — ${remaining.length} task(s) still waiting on dependencies.`
		: 'All tasks are complete.';
}

/**
 * Runs a single task end-to-end: mark in progress, append its notebook cells,
 * optionally execute them and capture realized Q_VARS, mark completed, and
 * record findings when the task is the analysis or writeup step.
 */
async function runTask(store: MiniQualiaStore, taskId: string): Promise<RunResult> {
	const project = store.project;
	const task = project?.tasks.find(t => t.id === taskId);
	if (!project || !task) {
		return { ran: false, message: `Task ${taskId} not found.`, findings: [] };
	}

	const agent = store.agentById(task.assignedAgentId);
	const label = agentLabel(agent);
	const notebookUri = project.notebookUri ? vscode.Uri.parse(project.notebookUri) : await ensureNotebook(store.workspaceUri);

	// 1. Mark in progress.
	await store.mutate(p => {
		if (!p.notebookUri) {
			p.notebookUri = notebookUri.toString();
		}
		setTaskStatus(p, taskId, 'in_progress');
		recomputeAgentStatuses(p);
		p.log.push({ at: new Date().toISOString(), actor: label, message: `Started ${taskId} — ${task.title}` });
	});
	showAgentTerminal(label, task);

	// 2. Append the task's notebook cells.
	const appended = await appendCells(notebookUri, cellsForTask(project, task, label));
	const codeCellIndex = appended.indices[appended.indices.length - 1];
	await store.mutate(p => {
		const t = p.tasks.find(x => x.id === taskId);
		if (t) {
			t.cellIndices = appended.indices;
		}
	});

	// 3. Execute and capture realized Q_VARS, when a kernel is available.
	let captured: Record<string, unknown> | undefined;
	let cellFailed = false;
	if (executionEnabled() && !executionUnavailable) {
		const ran = await executeCells(notebookUri, appended.indices);
		if (ran) {
			const doc = await vscode.workspace.openNotebookDocument(notebookUri);
			cellFailed = doc.cellAt(codeCellIndex).executionSummary?.success === false;
			captured = await readCellResult(notebookUri, codeCellIndex);
			if (captured) {
				const measured = captured;
				await store.mutate(p => { p.qvars = { ...(p.qvars ?? {}), ...measured }; });
				await writeQvars(store.workspaceUri, taskId, measured);
			}
		} else {
			markExecutionUnavailable(notebookUri);
		}
	}

	await delay(350);

	// 4. Mark completed or failed (real failures surface, like Qualia).
	const finalStatus: MiniQualiaTask['status'] = cellFailed ? 'failed' : 'completed';
	await store.mutate(p => {
		setTaskStatus(p, taskId, finalStatus);
		recomputeAgentStatuses(p);
		p.log.push({ at: new Date().toISOString(), actor: label, message: `${cellFailed ? 'Failed' : 'Completed'} ${taskId}${captured ? ' (measured)' : ''}` });
	});

	if (cellFailed) {
		return { ran: true, task, message: `${label} ran ${taskId} but the cell errored — marked failed.`, findings: [] };
	}

	// 5. Every completed task yields a claim (Qualia: a synthesized claim before
	//    completion), upgraded to notebook-captured + measured when the cell ran.
	const findings: MiniQualiaFinding[] = [];
	let writeupUri: vscode.Uri | undefined;
	const after = store.project!;
	const keyClaim = isResultTask(after, taskId) || isFinalTask(after, taskId);

	const claim = await recordTaskClaim(store, after, task, notebookUri, codeCellIndex, captured, keyClaim);
	findings.push(claim);

	if (isFinalTask(after, taskId)) {
		writeupUri = await exportWriteup(store);
		findings.push(await recordFinding(store, {
			kind: 'synthesized',
			claim: 'Exported a sourced Markdown writeup linking each claim to its notebook evidence.',
			summary: 'Generated by the writeup task.',
			taskId,
			source: { type: 'file', uri: writeupUri.toString() },
			relatedClaimIds: [claim.id]
		}));
	}

	const note = findings.length ? ` Captured ${findings.map(f => f.id).join(', ')}.` : '';
	return {
		ran: true,
		task,
		message: `${label} completed ${taskId} — ${task.title}.${note}`,
		writeupUri,
		findings
	};
}

/** Records the claim a task produces, linking it to upstream task claims. */
async function recordTaskClaim(store: MiniQualiaStore, project: MiniQualiaProject, task: MiniQualiaTask, notebookUri: vscode.Uri, cellIndex: number, captured: Record<string, unknown> | undefined, highLevel: boolean): Promise<MiniQualiaFinding> {
	const relatedClaimIds = task.dependencies.flatMap(depId => {
		const dep = project.tasks.find(t => t.id === depId);
		const last = dep?.resultFindingIds?.[dep.resultFindingIds.length - 1];
		return last ? [last] : [];
	});
	return recordFinding(store, {
		kind: captured ? 'notebook-captured' : 'synthesized',
		claim: captured ? claimFromCapture(task, captured) : `${task.title}: completed. ${task.objective}`,
		summary: captured
			? `Measured from the executed cell ${cellIndex}.`
			: 'Synthesized from the generated cell — run with a kernel to capture measured values.',
		taskId: task.id,
		source: { type: 'notebook-cell', uri: notebookUri.toString(), cellIndex },
		highLevel,
		metric: captured ? numericMetric(captured) : undefined,
		relatedClaimIds: relatedClaimIds.length ? relatedClaimIds : undefined
	});
}

/** Picks a representative numeric metric from a captured object (for overlays). */
function numericMetric(captured: Record<string, unknown>): number | undefined {
	for (const key of ['best_accuracy', 'accuracy', 'score', 'f1', 'r2']) {
		if (typeof captured[key] === 'number') {
			return captured[key] as number;
		}
	}
	const firstNum = Object.values(captured).find(v => typeof v === 'number');
	return typeof firstNum === 'number' ? firstNum : undefined;
}

/** Builds a human claim from a captured Q_VARS object. */
function claimFromCapture(task: MiniQualiaTask, captured: Record<string, unknown>): string {
	if (Object.hasOwn(captured, 'best_model') && Object.hasOwn(captured, 'best_accuracy')) {
		return `On the held-out split, ${captured.best_model} achieved the highest accuracy (${captured.best_accuracy}).`;
	}
	const pairs = Object.entries(captured)
		.slice(0, 4)
		.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
		.join(', ');
	return `${task.title}: ${pairs}`;
}

/** The last task in the plan is treated as the writeup/summary step. */
function isFinalTask(project: MiniQualiaProject, taskId: string): boolean {
	const last = project.tasks[project.tasks.length - 1];
	return !!last && last.id === taskId;
}

/** The task feeding the final task (most-connected dependency) is the result step. */
function isResultTask(project: MiniQualiaProject, taskId: string): boolean {
	const result = resultTaskId(project);
	return result !== undefined && result === taskId && !isFinalTask(project, taskId);
}

function resultTaskId(project: MiniQualiaProject): string | undefined {
	const tasks = project.tasks;
	if (tasks.length < 2) {
		return undefined;
	}
	const final = tasks[tasks.length - 1];
	const deps = final.dependencies
		.map(id => tasks.find(t => t.id === id))
		.filter((t): t is MiniQualiaTask => !!t);
	if (deps.length > 0) {
		return deps.reduce((best, t) => (t.dependencies.length >= best.dependencies.length ? t : best)).id;
	}
	return tasks[tasks.length - 2].id;
}

function setTaskStatus(project: MiniQualiaProject, taskId: string, status: MiniQualiaTask['status']): void {
	const task = project.tasks.find(t => t.id === taskId);
	if (task) {
		task.status = status;
		task.updatedAt = new Date().toISOString();
	}
}

/** Lets the agent set a task's status directly (e.g. mark failed/cancelled/paused). */
export async function setTaskStatusExternal(store: MiniQualiaStore, taskId: string, status: MiniQualiaTask['status']): Promise<boolean> {
	const exists = store.project?.tasks.some(t => t.id === taskId) ?? false;
	if (!exists) {
		return false;
	}
	await store.mutate(p => {
		setTaskStatus(p, taskId, status);
		recomputeAgentStatuses(p);
		p.log.push({ at: new Date().toISOString(), actor: 'agent', message: `Set ${taskId} → ${status}` });
	});
	return true;
}

/**
 * Recomputes each agent's status from its tasks: working if any task is in
 * progress, done if all complete, idle if it has a ready task, otherwise blocked.
 */
export function recomputeAgentStatuses(project: MiniQualiaProject): void {
	for (const agent of project.agents) {
		agent.status = computeAgentStatus(agent, project);
	}
}

function computeAgentStatus(agent: MiniQualiaAgent, project: MiniQualiaProject): MiniQualiaAgent['status'] {
	const tasks = agent.taskIds.map(id => project.tasks.find(t => t.id === id)).filter((t): t is MiniQualiaTask => !!t);
	if (tasks.length === 0) {
		return 'idle';
	}
	if (tasks.some(t => t.status === 'in_progress')) {
		return 'working';
	}
	if (tasks.every(t => t.status === 'completed')) {
		return 'done';
	}
	if (tasks.some(t => t.status === 'planned' && isUnblocked(t, project))) {
		return 'idle';
	}
	return 'blocked';
}

/** Marks execution unavailable for the session and hints once how to enable it. */
function markExecutionUnavailable(notebookUri: vscode.Uri): void {
	executionUnavailable = true;
	if (hintedNoKernel) {
		return;
	}
	hintedNoKernel = true;
	vscode.window.showInformationMessage(
		'MiniQualia: no notebook kernel ran the cells, so findings are synthesized. Select a Python/Jupyter kernel to capture measured results.',
		'Select Kernel'
	).then(choice => {
		if (choice === 'Select Kernel') {
			vscode.commands.executeCommand('notebook.selectKernel', { notebookEditor: { notebookUri } });
		}
	});
}

/**
 * Shows the shared agent terminal and echoes the task being worked, for flavor.
 * Skipped in untrusted workspaces, where launching a terminal process is blocked.
 */
function showAgentTerminal(label: string, task: MiniQualiaTask): void {
	if (!vscode.workspace.isTrusted) {
		return;
	}
	const existing = vscode.window.terminals.find(t => t.name === TERMINAL_NAME);
	const terminal = existing ?? vscode.window.createTerminal(TERMINAL_NAME);
	terminal.show(true);
	terminal.sendText(`echo "[${label}] ${task.id} ${task.title}"`);
}
