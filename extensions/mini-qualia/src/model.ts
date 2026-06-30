/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The lifecycle status of a {@link MiniQualiaTask}. Mirrors the way Qualia tracks
 * task progress (planned -> in progress -> completed) plus the failure and
 * human-in-the-loop states a research workflow needs.
 */
export type TaskStatus =
	| 'planned'
	| 'in_progress'
	| 'completed'
	| 'failed'
	| 'cancelled'
	| 'paused_by_user';

/**
 * A research session. This is the single document persisted to
 * `.miniqualia/state.json` and the source of truth for every MiniQualia view.
 */
export interface MiniQualiaProject {
	id: string;
	name: string;
	/** The research question that seeded the session. */
	prompt?: string;
	/** URI (string form) of the backing Jupyter notebook, the source of truth. */
	notebookUri?: string;
	createdAt: string;
	updatedAt: string;
	agents: MiniQualiaAgent[];
	tasks: MiniQualiaTask[];
	findings: MiniQualiaFinding[];
	skills: MiniQualiaSkill[];
	/** Append-only activity log, used to simulate Qualia's autonomous "Infinity" updates. */
	log: MiniQualiaLogEntry[];
	/**
	 * Named values captured from executed notebook cells (the realized Q_VARS).
	 * Populated when notebook execution is enabled and a kernel is available;
	 * cited by findings and the writeup so claims are grounded in measured output.
	 */
	qvars?: Record<string, unknown>;
}

/**
 * A task worker. In Qualia, agents have "Curiosity" and "Independence"; here we
 * model independence as a tier from low to `infinity` (fully autonomous).
 */
export interface MiniQualiaAgent {
	id: string;
	name: string;
	status: 'idle' | 'working' | 'blocked' | 'done';
	independence: 'low' | 'medium' | 'high' | 'infinity';
	taskIds: string[];
}

/**
 * A unit of research work. Tasks form a DAG via {@link dependencies}.
 */
export interface MiniQualiaTask {
	id: string;
	title: string;
	objective: string;
	status: TaskStatus;
	dependencies: string[];
	assignedAgentId: string;
	/**
	 * The notebook variables this task is expected to produce. This is the
	 * MiniQualia analogue of Qualia's Q_VARS: named values that flow between
	 * tasks in a multi-step workflow.
	 */
	requiredVars?: string[];
	/**
	 * Optional runnable Python for this task's code cell. The LLM planner fills
	 * this so arbitrary plans are executable; the deterministic planner leaves it
	 * unset and the notebook module supplies a built-in recipe instead.
	 */
	code?: string;
	resultFindingIds?: string[];
	/** Indices of notebook cells this task appended, for provenance. */
	cellIndices?: number[];
	createdAt: string;
	updatedAt: string;
}

/**
 * An auditable claim. Every finding links back to the evidence that produced it
 * ("every finding, fully sourced").
 */
export interface MiniQualiaFinding {
	id: string;
	kind: 'notebook-captured' | 'synthesized';
	claim: string;
	summary?: string;
	taskId?: string;
	source: MiniQualiaEvidenceSource;
	createdAt: string;
	/** Key findings are surfaced prominently and injected into the agent's context. */
	highLevel?: boolean;
	/** Optional numeric metric for "color by metric" overlays. */
	metric?: number;
	/** Ids of other claims this claim builds on (the claim graph). */
	relatedClaimIds?: string[];
	/** Set when validation finds the claim's evidence has drifted or errors. */
	stale?: boolean;
	/** Timestamp of the last validation against sources. */
	validatedAt?: string;
}

/**
 * Where a finding's evidence lives. Drives "go to source" navigation.
 */
export interface MiniQualiaEvidenceSource {
	type: 'notebook-cell' | 'file' | 'terminal' | 'manual';
	uri?: string;
	cellIndex?: number;
	cellId?: string;
	command?: string;
}

/**
 * A reusable research recipe exposed as a slash command, analogous to Qualia's
 * Skills (which can be imported from Cursor or Claude Code).
 */
export interface MiniQualiaSkill {
	id: string;
	name: string;
	slashCommand: string;
	description: string;
	template: string;
}

/**
 * An entry in the session activity log.
 */
export interface MiniQualiaLogEntry {
	at: string;
	actor: string;
	message: string;
}

/** Independence tiers, ordered. */
export const INDEPENDENCE_TIERS: ReadonlyArray<MiniQualiaAgent['independence']> = ['low', 'medium', 'high', 'infinity'];

/**
 * The default Skills library. These mirror the kinds of research recipes a
 * Qualia user would import or author. Each is a slash command with a prompt
 * template that gets inserted into chat.
 */
export const DEFAULT_SKILLS: ReadonlyArray<MiniQualiaSkill> = [
	{
		id: 'skill-clean-data',
		name: 'Clean Data',
		slashCommand: '/clean-data',
		description: 'Standardize columns, handle missing values, and de-duplicate a dataset.',
		template: 'Clean the dataset: drop duplicates, impute or drop missing values, normalize column names, and report the row/column counts before and after.'
	},
	{
		id: 'skill-eda-pipeline',
		name: 'EDA Pipeline',
		slashCommand: '/eda-pipeline',
		description: 'Run a standard exploratory data analysis pass with summary stats and plots.',
		template: 'Run an exploratory data analysis: describe each feature, plot distributions and correlations, and call out anything surprising in the data.'
	},
	{
		id: 'skill-stat-tests',
		name: 'Statistical Tests',
		slashCommand: '/stat-tests',
		description: 'Pick and run appropriate significance tests for the comparison at hand.',
		template: 'Choose and run appropriate statistical tests to compare the groups, report test statistics and p-values, and state whether differences are significant.'
	},
	{
		id: 'skill-plot-styles',
		name: 'Plot Styles',
		slashCommand: '/plot-styles',
		description: 'Apply a consistent, publication-ready styling to all charts.',
		template: 'Apply a consistent publication-ready style to every chart: shared color palette, labeled axes, titles, and legible font sizes.'
	},
	{
		id: 'skill-literature-review',
		name: 'Literature Review',
		slashCommand: '/literature-review',
		description: 'Summarize relevant prior work and methods with citations.',
		template: 'Summarize relevant prior work and standard methods for this problem, with citations, and note how they inform the approach taken here.'
	}
];
