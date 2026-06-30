/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createMessage } from './llm/anthropicClient';
import { MiniQualiaAgent, MiniQualiaTask } from './model';
import { nowIso } from './storage';

/**
 * The output of a planning pass: a task DAG plus the agents that own the tasks.
 */
export interface ResearchPlan {
	prompt: string;
	tasks: MiniQualiaTask[];
	agents: MiniQualiaAgent[];
}

/**
 * Turns a research question into a task DAG. The default implementation is
 * deterministic so the demo is reliable; swapping in an LLM-backed planner only
 * requires another implementation of this interface (see README).
 */
export interface ResearchPlanner {
	readonly id: string;
	plan(prompt: string): Promise<ResearchPlan>;
}

/**
 * Deterministic, template-based planner. Recognizes the iris model-comparison
 * prompt and emits the canonical six-task DAG; for any other prompt it emits a
 * generic five-task research DAG.
 */
export class DeterministicPlanner implements ResearchPlanner {

	readonly id = 'deterministic';

	async plan(prompt: string): Promise<ResearchPlan> {
		const tasks = this.isModelComparison(prompt) ? this.modelComparisonTasks() : this.genericTasks();
		const agents = this.isModelComparison(prompt) ? this.modelComparisonAgents() : this.genericAgents();
		this.assignTasksToAgents(tasks, agents);
		return { prompt, tasks, agents };
	}

	private isModelComparison(prompt: string): boolean {
		const text = prompt.toLowerCase();
		return /\biris\b/.test(text)
			|| /\b(three|3)\b[\s\S]*\bmodels?\b/.test(text)
			|| /\bcompare\b[\s\S]*\bmodels?\b/.test(text);
	}

	private modelComparisonTasks(): MiniQualiaTask[] {
		return [
			this.task('T-1', 'Load and inspect the dataset', 'Load the iris dataset and inspect its shape, features, and class balance.', [], ['df', 'X', 'y']),
			this.task('T-2', 'Train baseline logistic regression', 'Train a logistic regression baseline and record its held-out accuracy.', ['T-1'], ['results']),
			this.task('T-3', 'Train random forest', 'Train a random forest classifier and record its held-out accuracy.', ['T-1'], ['results']),
			this.task('T-4', 'Train support vector machine', 'Train an RBF-kernel SVM and record its held-out accuracy.', ['T-1'], ['results']),
			this.task('T-5', 'Compare model metrics and choose best approach', 'Compare the three models on held-out accuracy and select the best one.', ['T-2', 'T-3', 'T-4'], ['results', 'best_model', 'best_accuracy']),
			this.task('T-6', 'Produce sourced research writeup', 'Export a short Markdown writeup that cites the notebook evidence for each finding.', ['T-5'])
		];
	}

	private genericTasks(): MiniQualiaTask[] {
		return [
			this.task('T-1', 'Understand data and objective', 'Clarify the research objective and inspect the available data.', [], ['df']),
			this.task('T-2', 'Clean and prepare data', 'Clean, normalize, and split the data for analysis.', ['T-1'], ['X', 'y']),
			this.task('T-3', 'Run analysis or experiment', 'Run the core analysis or experiment for the question.', ['T-2'], ['results']),
			this.task('T-4', 'Validate and compare results', 'Validate the results and compare alternatives.', ['T-3'], ['best_result']),
			this.task('T-5', 'Summarize findings', 'Summarize the findings into a sourced writeup.', ['T-4'])
		];
	}

	private modelComparisonAgents(): MiniQualiaAgent[] {
		return [
			this.agent('A-1', 'Research Lead', 'infinity'),
			this.agent('A-2', 'Modeling Agent', 'high'),
			this.agent('A-3', 'Modeling Agent', 'medium')
		];
	}

	private genericAgents(): MiniQualiaAgent[] {
		return [
			this.agent('A-1', 'Research Lead', 'infinity'),
			this.agent('A-2', 'Analysis Agent', 'high')
		];
	}

	/**
	 * Distributes tasks across agents. The Research Lead owns framing,
	 * comparison, and writeup; modeling/analysis agents take the parallel
	 * experiment tasks (mirroring Qualia spawning agents to test hypotheses).
	 */
	private assignTasksToAgents(tasks: MiniQualiaTask[], agents: MiniQualiaAgent[]): void {
		const byId = new Map(agents.map(a => [a.id, a]));
		const ids = tasks.map(t => t.id);
		const isModelComparison = ids.includes('T-6');

		const assignment: Record<string, string> = isModelComparison
			? { 'T-1': 'A-1', 'T-2': 'A-2', 'T-3': 'A-2', 'T-4': 'A-3', 'T-5': 'A-1', 'T-6': 'A-1' }
			: { 'T-1': 'A-1', 'T-2': 'A-2', 'T-3': 'A-2', 'T-4': 'A-1', 'T-5': 'A-1' };

		for (const taskId of Object.keys(assignment)) {
			const agentId = assignment[taskId];
			const task = tasks.find(t => t.id === taskId);
			const agent = byId.get(agentId);
			if (task && agent) {
				task.assignedAgentId = agentId;
				agent.taskIds.push(taskId);
			}
		}
	}

	private task(id: string, title: string, objective: string, dependencies: string[], requiredVars?: string[]): MiniQualiaTask {
		const at = nowIso();
		return {
			id,
			title,
			objective,
			status: 'planned',
			dependencies,
			assignedAgentId: '',
			requiredVars,
			resultFindingIds: [],
			cellIndices: [],
			createdAt: at,
			updatedAt: at
		};
	}

	private agent(id: string, name: string, independence: MiniQualiaAgent['independence']): MiniQualiaAgent {
		return { id, name, status: 'idle', independence, taskIds: [] };
	}
}

const INDEPENDENCE_VALUES: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'infinity']);

/** JSON schema for the planner's forced tool call. */
const PLAN_TOOL = {
	name: 'emit_plan',
	description: 'Emit a research task DAG and the agents that own the tasks.',
	input_schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			agents: {
				type: 'array',
				description: '2-3 agents. One Research Lead with infinity independence owns framing and synthesis; others run experiments.',
				items: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Agent id like A-1.' },
						name: { type: 'string' },
						independence: { type: 'string', enum: ['low', 'medium', 'high', 'infinity'] }
					},
					required: ['id', 'name', 'independence']
				}
			},
			tasks: {
				type: 'array',
				description: '4-8 tasks in topological order; the final task summarizes/writes up the work.',
				items: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Task id like T-1, in order.' },
						title: { type: 'string' },
						objective: { type: 'string' },
						dependencies: { type: 'array', items: { type: 'string' }, description: 'Ids of earlier tasks this depends on.' },
						assignedAgentId: { type: 'string', description: 'Owning agent id.' },
						requiredVars: { type: 'array', items: { type: 'string' }, description: 'Python variables this task produces.' },
						code: { type: 'string', description: 'Runnable Python for one Jupyter cell. Build on earlier tasks\' variables. End with print(json.dumps({...})) of this task\'s requiredVars so results can be captured. Use only pandas, numpy, scikit-learn, matplotlib. Set random_state for reproducibility.' }
					},
					required: ['id', 'title', 'objective', 'dependencies', 'assignedAgentId', 'code']
				}
			}
		},
		required: ['agents', 'tasks']
	}
} as const;

const PLANNER_SYSTEM = [
	'You are MiniQualia\'s research planner. Turn a research question into a small, concrete task DAG that runs in a Jupyter notebook.',
	'Rules:',
	'- Produce 4-8 tasks in topological order with ids T-1, T-2, ... Dependencies must reference only earlier task ids (a DAG, no cycles).',
	'- Define 2-3 agents with ids A-1, A-2, ... A-1 is the "Research Lead" (independence "infinity") and owns the first framing task, the comparison/validation task, and the final writeup. Other agents (independence "high"/"medium") own parallel experiment tasks.',
	'- The FINAL task must summarize the work (its title/objective should say "writeup" or "summary"); it depends on the analysis task(s).',
	'- For each task, write runnable Python for a single Jupyter cell in `code`. Later cells may use variables defined by earlier cells, and may also read upstream captured values via `Q_VARS.get(task_ids=["T-1"])` (MiniQualia injects Q_VARS). Each cell MUST end by printing exactly one line: print(json.dumps({...})) containing the task\'s requiredVars as JSON-serializable values, so MiniQualia can capture the results. Import json and whatever you need. Use only pandas, numpy, scikit-learn, matplotlib. Set random_state where relevant.',
	'- Prefer real, self-contained datasets (e.g. sklearn.datasets) when the question does not name a specific dataset.',
	'Call the emit_plan tool with the plan. Do not write prose.'
].join('\n');

interface RawAgent { id?: unknown; name?: unknown; independence?: unknown }
interface RawTask { id?: unknown; title?: unknown; objective?: unknown; dependencies?: unknown; assignedAgentId?: unknown; requiredVars?: unknown; code?: unknown }
interface RawPlan { agents?: RawAgent[]; tasks?: RawTask[] }

/**
 * LLM-backed planner. Asks Claude to emit a task DAG via a forced tool call,
 * then normalizes and validates it into a {@link ResearchPlan}. Falls back to
 * the deterministic planner on any error so the flow never breaks.
 */
export class LlmPlanner implements ResearchPlanner {

	readonly id = 'llm';
	private readonly fallback = new DeterministicPlanner();

	constructor(private readonly apiKey: string) { }

	async plan(prompt: string): Promise<ResearchPlan> {
		try {
			const result = await createMessage(this.apiKey, {
				system: PLANNER_SYSTEM,
				maxTokens: 4096,
				messages: [{ role: 'user', content: prompt }],
				tools: [PLAN_TOOL],
				toolChoice: { type: 'tool', name: 'emit_plan' }
			});
			const call = result.toolUses.find(t => t.name === 'emit_plan');
			if (!call) {
				throw new Error('Planner returned no plan.');
			}
			return this.normalize(prompt, call.input as RawPlan);
		} catch (err) {
			console.error('MiniQualia LLM planner failed, falling back to deterministic:', err);
			return this.fallback.plan(prompt);
		}
	}

	/** Coerces a raw model plan into a valid, acyclic, fully-assigned plan. */
	private normalize(prompt: string, raw: RawPlan): ResearchPlan {
		const at = nowIso();

		const agents: MiniQualiaAgent[] = (raw.agents ?? [])
			.filter(a => typeof a.id === 'string' && typeof a.name === 'string')
			.map(a => ({
				id: String(a.id),
				name: String(a.name),
				status: 'idle',
				independence: INDEPENDENCE_VALUES.has(String(a.independence)) ? a.independence as MiniQualiaAgent['independence'] : 'medium',
				taskIds: []
			}));
		if (agents.length === 0) {
			agents.push({ id: 'A-1', name: 'Research Lead', status: 'idle', independence: 'infinity', taskIds: [] });
		}

		const rawTasks = (raw.tasks ?? []).filter(t => typeof t.title === 'string');
		if (rawTasks.length === 0) {
			throw new Error('Planner returned no tasks.');
		}

		// Assign sequential ids, preserving any the model already used for dependency matching.
		const ids = rawTasks.map((t, i) => (typeof t.id === 'string' && t.id.trim()) ? String(t.id) : `T-${i + 1}`);
		const idIndex = new Map(ids.map((id, i) => [id, i]));

		const tasks: MiniQualiaTask[] = rawTasks.map((t, i) => {
			const deps = Array.isArray(t.dependencies)
				? (t.dependencies as unknown[])
					.map(d => String(d))
					// Keep only dependencies on strictly-earlier tasks (guarantees acyclicity).
					.filter(d => idIndex.has(d) && (idIndex.get(d) as number) < i)
				: [];
			const assigned = typeof t.assignedAgentId === 'string' && agents.some(a => a.id === t.assignedAgentId)
				? String(t.assignedAgentId)
				: '';
			const requiredVars = Array.isArray(t.requiredVars) ? (t.requiredVars as unknown[]).map(v => String(v)) : undefined;
			return {
				id: ids[i],
				title: String(t.title),
				objective: typeof t.objective === 'string' ? String(t.objective) : String(t.title),
				status: 'planned',
				dependencies: deps,
				assignedAgentId: assigned,
				requiredVars,
				code: typeof t.code === 'string' && t.code.trim() ? String(t.code) : undefined,
				resultFindingIds: [],
				cellIndices: [],
				createdAt: at,
				updatedAt: at
			};
		});

		this.assignUnowned(tasks, agents);
		for (const task of tasks) {
			agents.find(a => a.id === task.assignedAgentId)?.taskIds.push(task.id);
		}

		return { prompt, tasks, agents };
	}

	/** Ensures every task has an owner: lead takes first + last, others round-robin. */
	private assignUnowned(tasks: MiniQualiaTask[], agents: MiniQualiaAgent[]): void {
		const lead = agents[0];
		const workers = agents.length > 1 ? agents.slice(1) : agents;
		let next = 0;
		tasks.forEach((task, i) => {
			if (task.assignedAgentId) {
				return;
			}
			const isFramingOrFinal = i === 0 || i === tasks.length - 1;
			task.assignedAgentId = isFramingOrFinal ? lead.id : workers[next++ % workers.length].id;
		});
	}
}

/**
 * Chooses a planner. With an API key and `auto` mode, uses the LLM planner
 * (which falls back to deterministic on failure); otherwise deterministic.
 */
export function createPlanner(apiKey: string | undefined, mode: 'auto' | 'deterministic'): ResearchPlanner {
	if (apiKey && mode === 'auto') {
		return new LlmPlanner(apiKey);
	}
	return new DeterministicPlanner();
}
