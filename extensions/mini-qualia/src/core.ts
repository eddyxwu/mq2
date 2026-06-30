/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { recomputeAgentStatuses } from './agentRunner';
import { DEFAULT_SKILLS, MiniQualiaProject } from './model';
import { ensureNotebook } from './notebook';
import { ResearchPlan, ResearchPlanner } from './planner';
import { MiniQualiaStore, nowIso } from './storage';

/**
 * Shared session/planning logic used by both the interactive commands and the
 * agentic chat tools, kept here to avoid a circular import between them.
 */

/** Creates a fresh, empty research session. */
export function createProject(prompt?: string): MiniQualiaProject {
	const at = nowIso();
	return {
		id: `session-${Date.now()}`,
		name: 'MiniQualia Research Session',
		prompt,
		createdAt: at,
		updatedAt: at,
		agents: [],
		tasks: [],
		findings: [],
		skills: DEFAULT_SKILLS.map(s => ({ ...s })),
		log: [{ at, actor: 'MiniQualia', message: 'Research session started.' }]
	};
}

/**
 * Ensures there is an active session backed by an open notebook, creating both
 * if needed. Returns false only when no workspace folder is open (non-interactive
 * — callers decide whether to prompt the user to open one).
 */
export async function ensureSessionCore(store: MiniQualiaStore, prompt?: string): Promise<boolean> {
	if (!store.hasWorkspace) {
		return false;
	}
	if (!store.project) {
		await store.setProject(createProject(prompt));
	}
	const uri = await ensureNotebook(store.workspaceUri);
	if (!store.project!.notebookUri) {
		await store.mutate(p => { p.notebookUri = uri.toString(); });
	}
	return true;
}

/** Runs the planner and installs the resulting DAG + agents into the session. */
export async function planTasksCore(store: MiniQualiaStore, planner: ResearchPlanner, prompt: string): Promise<ResearchPlan> {
	const plan = await planner.plan(prompt);
	await store.mutate(p => {
		p.prompt = plan.prompt;
		p.tasks = plan.tasks;
		p.agents = plan.agents;
		recomputeAgentStatuses(p);
		p.log.push({ at: nowIso(), actor: 'Research Lead', message: `Planned ${plan.tasks.length} tasks across ${plan.agents.length} agents (${planner.id}).` });
	});
	return plan;
}
