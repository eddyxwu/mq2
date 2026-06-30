/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { runNextTask, runReadyTasks, setTaskStatusExternal } from '../agentRunner';
import { findSkill, loadRules, loadSkills } from '../context';
import { ensureSessionCore, planTasksCore } from '../core';
import { TaskStatus } from '../model';
import { appendMarkdownCell, ensureQvarsSetup, runCodeCell } from '../notebook';
import { ResearchPlanner } from '../planner';
import { MiniQualiaStore } from '../storage';
import { editFile, grepSearch, listDir, readFile, runCommand, writeFile } from '../workspace';
import { captureFindingGrounded, exportWriteup, WRITEUP_FILENAME } from '../writeup';
import { ContentBlock, LlmMessage, streamMessage, ToolDefinition } from './anthropicClient';

const MAX_ITERATIONS = 24;

/** Parameters for one agentic chat turn. */
export interface AgentTurnParams {
	apiKey: string;
	store: MiniQualiaStore;
	planner: ResearchPlanner;
	context: vscode.ExtensionContext;
	signal: AbortSignal;
	/** Conversation history, mutated in place so multi-turn context persists. */
	history: LlmMessage[];
	userText: string;
	onAssistantStart: () => void;
	onText: (delta: string) => void;
	onAssistantEnd: () => void;
	onTool: (label: string, output: string) => void;
	onUsage: (input: number, output: number) => void;
}

const AGENT_TOOLS: ToolDefinition[] = [
	// Notebook — the primary way to "do something"; every action is an inspectable cell.
	{ name: 'run_code', description: 'Append a Python cell to the notebook and run it with the kernel. Returns its output (or error). Use this for all data work — every action becomes an inspectable cell.', input_schema: { type: 'object', properties: { code: { type: 'string', description: 'Python for one cell.' } }, required: ['code'] } },
	{ name: 'add_markdown', description: 'Append a markdown cell to the notebook (a heading or note).', input_schema: { type: 'object', properties: { markdown: { type: 'string' } }, required: ['markdown'] } },
	// Workspace — Cursor-like file + shell tools over the real project.
	{ name: 'list_dir', description: 'List files in a workspace directory.', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Directory, relative to the workspace root. Default ".".' } } } },
	{ name: 'read_file', description: 'Read a text file from the workspace.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
	{ name: 'grep', description: 'Search workspace text files for a regex; returns file:line matches.', input_schema: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string', description: 'Subdirectory to search. Default ".".' } }, required: ['query'] } },
	{ name: 'write_file', description: 'Create or overwrite a workspace text file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
	{ name: 'edit_file', description: 'Replace the first occurrence of a string in a workspace file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } }, required: ['path', 'find', 'replace'] } },
	{ name: 'run_command', description: 'Run a shell command in the workspace root (e.g. install packages, run scripts, git). Returns combined output.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
	// Research orchestration.
	{ name: 'plan_tasks', description: 'Generate a notebook-grounded task DAG and agents for a research question.', input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
	{ name: 'run_ready_tasks', description: 'Run all unblocked tasks in parallel waves until the DAG completes.', input_schema: { type: 'object', properties: {} } },
	{ name: 'run_next_task', description: 'Run the single next unblocked task.', input_schema: { type: 'object', properties: {} } },
	{ name: 'set_task_status', description: 'Set a task status (planned, in_progress, completed, failed, cancelled, paused_by_user).', input_schema: { type: 'object', properties: { task_id: { type: 'string' }, status: { type: 'string', enum: ['planned', 'in_progress', 'completed', 'failed', 'cancelled', 'paused_by_user'] } }, required: ['task_id', 'status'] } },
	{ name: 'capture_finding', description: 'Record an auditable claim grounded in notebook evidence. Mark high_level for key findings (injected into future context).', input_schema: { type: 'object', properties: { claim: { type: 'string' }, high_level: { type: 'boolean' }, metric: { type: 'number', description: 'Optional numeric metric (e.g. accuracy).' } }, required: ['claim'] } },
	{ name: 'export_writeup', description: 'Write and open the sourced Markdown writeup.', input_schema: { type: 'object', properties: {} } },
	{ name: 'get_state', description: 'Inspect current tasks, findings, agents, and measured variables (Q_VARS).', input_schema: { type: 'object', properties: {} } }
];

function independenceClause(level: string): string {
	switch (level) {
		case 'low': return 'Independence: LOW — ask for confirmation before any non-trivial action.';
		case 'medium': return 'Independence: MEDIUM — make routine decisions yourself; ask about significant ones.';
		case 'infinity': return 'Independence: INFINITY (autonomous) — never ask for confirmation. Keep working until the goal is fully achieved; make all decisions yourself and report progress as you go.';
		default: return 'Independence: HIGH — assume most things and proceed; only ask about major choices.';
	}
}

function curiosityClause(level: string): string {
	switch (level) {
		case 'low': return 'Curiosity: LOW — stay focused on exactly what was asked.';
		case 'high': return 'Curiosity: HIGH — actively investigate tangential and related questions.';
		default: return 'Curiosity: MEDIUM — explore clearly related areas when relevant.';
	}
}

/** Builds the system prompt: persona + research style + rules + key findings + skills. */
async function buildSystemPrompt(store: MiniQualiaStore): Promise<string> {
	const cfg = vscode.workspace.getConfiguration('miniQualia');
	const independence = cfg.get<string>('independence') ?? 'high';
	const curiosity = cfg.get<string>('curiosity') ?? 'medium';

	const parts: string[] = [
		'You are MiniQualia, a research agent embedded in VS Code — a coding agent for researchers, like Qualia. You work in a real project workspace and a Jupyter notebook.',
		'You always work by taking visible actions: write and run notebook cells (run_code), read/grep/edit files, and run shell commands. Nothing happens behind the scenes — every action is an inspectable cell or command. Inspect outputs and iterate.',
		'For multi-step research, plan a task DAG (plan_tasks) and run it (run_ready_tasks runs independent tasks in parallel). When you finish a task, capture a claim (capture_finding) grounded in the evidence; mark key results high_level. Export a sourced writeup at the end (export_writeup).',
		'If a step fails, say so, set the task failed (set_task_status), diagnose, and recover.',
		independenceClause(independence),
		curiosityClause(curiosity)
	];

	const rules = await loadRules(store.hasWorkspace ? store.workspaceUri : undefined);
	if (rules) {
		parts.push(`Workspace rules (follow these):\n${rules}`);
	}

	const highLevel = (store.project?.findings ?? []).filter(f => f.highLevel);
	if (highLevel.length) {
		parts.push(`Key findings so far:\n${highLevel.map(f => `- ${f.id}: ${f.claim}`).join('\n')}`);
	}

	const skills = (await loadSkills(store.hasWorkspace ? store.workspaceUri : undefined)).filter(s => s.autoInvoke);
	if (skills.length) {
		parts.push(`Available skills (follow the matching one when relevant; the user may also invoke /name):\n${skills.map(s => `- /${s.name}: ${s.description}`).join('\n')}`);
	}

	return parts.join('\n\n');
}

interface ToolResult { content: string; isError?: boolean }
function ok(content: string): ToolResult { return { content }; }
function err(content: string): ToolResult { return { content, isError: true }; }

function stateSummary(store: MiniQualiaStore): object {
	const p = store.project;
	if (!p) {
		return { session: 'none' };
	}
	return {
		prompt: p.prompt,
		notebook: p.notebookUri ? 'analysis.ipynb' : null,
		tasks: p.tasks.map(t => ({ id: t.id, title: t.title, status: t.status, dependsOn: t.dependencies, agent: t.assignedAgentId })),
		agents: p.agents.map(a => ({ id: a.id, name: a.name, status: a.status, independence: a.independence })),
		findings: p.findings.map(f => ({ id: f.id, kind: f.kind, highLevel: !!f.highLevel, claim: f.claim })),
		qvars: p.qvars ?? {}
	};
}

async function notebookUri(store: MiniQualiaStore): Promise<vscode.Uri | undefined> {
	if (!(await ensureSessionCore(store))) {
		return undefined;
	}
	return store.project?.notebookUri ? vscode.Uri.parse(store.project.notebookUri) : undefined;
}

async function executeTool(name: string, input: unknown, params: AgentTurnParams): Promise<ToolResult> {
	const args = (input ?? {}) as Record<string, unknown>;
	const store = params.store;
	const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
	try {
		switch (name) {
			case 'run_code': {
				const uri = await notebookUri(store);
				if (!uri) { return err('No workspace folder is open.'); }
				await ensureQvarsSetup(uri);
				const r = await runCodeCell(uri, str(args.code));
				return { content: `cell ${r.cellIndex} ${r.ok ? 'ran' : 'failed/ no-kernel'}:\n${r.output}`, isError: !r.ok };
			}
			case 'add_markdown': {
				const uri = await notebookUri(store);
				if (!uri) { return err('No workspace folder is open.'); }
				const i = await appendMarkdownCell(uri, str(args.markdown));
				return ok(`Added markdown cell ${i}.`);
			}
			case 'list_dir':
				return store.hasWorkspace ? ok(await listDir(store.workspaceUri, str(args.path, '.'))) : err('No workspace folder.');
			case 'read_file':
				return store.hasWorkspace ? ok(await readFile(store.workspaceUri, str(args.path))) : err('No workspace folder.');
			case 'grep':
				return store.hasWorkspace ? ok(await grepSearch(store.workspaceUri, str(args.query), str(args.path, '.'))) : err('No workspace folder.');
			case 'write_file':
				return store.hasWorkspace ? ok(await writeFile(store.workspaceUri, str(args.path), str(args.content))) : err('No workspace folder.');
			case 'edit_file':
				return store.hasWorkspace ? ok(await editFile(store.workspaceUri, str(args.path), str(args.find), str(args.replace))) : err('No workspace folder.');
			case 'run_command': {
				if (!store.hasWorkspace) { return err('No workspace folder.'); }
				const command = str(args.command);
				const independence = vscode.workspace.getConfiguration('miniQualia').get<string>('independence') ?? 'high';
				if (!(await approveCommand(params.context, command, independence))) {
					return err('Command skipped by the user.');
				}
				return ok(await runCommand(store.workspaceUri, command, params.signal));
			}
			case 'plan_tasks': {
				const prompt = str(args.prompt) || params.userText;
				if (!(await ensureSessionCore(store, prompt))) { return err('No workspace folder is open.'); }
				const plan = await planTasksCore(store, params.planner, prompt);
				return ok(`Planned ${plan.tasks.length} tasks across ${plan.agents.length} agents: ${plan.tasks.map(t => `${t.id} ${t.title}`).join('; ')}.`);
			}
			case 'run_ready_tasks':
				return store.project ? ok((await runReadyTasks(store)).message) : err('No tasks planned — call plan_tasks first.');
			case 'run_next_task':
				return store.project ? ok((await runNextTask(store)).message) : err('No tasks planned — call plan_tasks first.');
			case 'set_task_status': {
				const done = await setTaskStatusExternal(store, str(args.task_id), str(args.status) as TaskStatus);
				return done ? ok(`Set ${args.task_id} → ${args.status}.`) : err(`Task ${args.task_id} not found.`);
			}
			case 'capture_finding': {
				if (!store.project) { return err('No active session.'); }
				const f = await captureFindingGrounded(store, str(args.claim, 'Finding'), {
					highLevel: args.high_level === true,
					metric: typeof args.metric === 'number' ? args.metric : undefined
				});
				return ok(`Captured ${f.id}${f.highLevel ? ' (high-level)' : ''}: ${f.claim}`);
			}
			case 'export_writeup': {
				if (!store.project) { return err('No active session.'); }
				const uri = await exportWriteup(store);
				vscode.commands.executeCommand('markdown.showPreview', uri).then(undefined, () => vscode.commands.executeCommand('vscode.open', uri));
				return ok(`Exported ${WRITEUP_FILENAME}.`);
			}
			case 'get_state':
				return ok(JSON.stringify(stateSummary(store)));
			default:
				return err(`Unknown tool: ${name}`);
		}
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}
}

const ALLOWLIST_KEY = 'miniQualia.bashAllowlist';

/** Confirms a shell command unless independence is high/infinity or it's allowlisted. */
async function approveCommand(context: vscode.ExtensionContext, command: string, independence: string): Promise<boolean> {
	if (independence === 'high' || independence === 'infinity') {
		return true;
	}
	const first = command.trim().split(/\s+/)[0] ?? '';
	const allow = context.globalState.get<string[]>(ALLOWLIST_KEY, []);
	if (first && allow.includes(first)) {
		return true;
	}
	const choice = await vscode.window.showWarningMessage(
		'MiniQualia wants to run a shell command:',
		{ modal: true, detail: command },
		'Run', 'Run & Always Allow', 'Skip'
	);
	if (choice === 'Run & Always Allow') {
		await context.globalState.update(ALLOWLIST_KEY, [...allow, first]);
		return true;
	}
	return choice === 'Run';
}

/** Short transcript note for a tool call. */
function toolNote(name: string, input: unknown): string {
	const a = (input ?? {}) as Record<string, unknown>;
	const detail = name === 'run_command' ? `: ${String(a.command ?? '').slice(0, 60)}`
		: name === 'run_code' ? '' : name === 'read_file' || name === 'list_dir' || name === 'write_file' || name === 'edit_file' ? `: ${String(a.path ?? '')}`
			: name === 'grep' ? `: /${String(a.query ?? '')}/` : name === 'plan_tasks' ? `: ${String(a.prompt ?? '').slice(0, 50)}` : '';
	return `${name}${detail}`;
}

/** Resolves leading `/skill` and `@rule:name` references into the message. */
async function preprocess(userText: string, store: MiniQualiaStore): Promise<string> {
	let text = userText;
	const wsUri = store.hasWorkspace ? store.workspaceUri : undefined;

	const slash = userText.match(/(?:^|\s)\/([a-zA-Z0-9_-]+)/g) || [];
	if (slash.length) {
		const skills = await loadSkills(wsUri);
		for (const token of slash) {
			const skill = findSkill(skills, token.trim().slice(1));
			if (skill) {
				text += `\n\n[Skill: ${skill.name}]\n${skill.instructions}`;
			}
		}
	}

	const ruleRefs = userText.match(/@rule:([a-zA-Z0-9_-]+)/g) || [];
	for (const ref of ruleRefs) {
		const ruleName = ref.split(':')[1];
		if (wsUri) {
			try {
				const body = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(wsUri, '.miniqualia', 'rules', `${ruleName}.md`)));
				text += `\n\n[Rule: ${ruleName}]\n${body}`;
			} catch {
				// Rule file not found; ignore.
			}
		}
	}

	return text;
}

/**
 * Runs one agentic chat turn: streams the model's reply, executes any tool
 * calls against the workspace/notebook/research surface, and loops until the
 * model stops calling tools.
 */
export async function runAgentTurn(params: AgentTurnParams): Promise<void> {
	// Always work notebook-grounded when a folder is open.
	await ensureSessionCore(params.store).catch(() => undefined);

	const system = await buildSystemPrompt(params.store);
	params.history.push({ role: 'user', content: await preprocess(params.userText, params.store) });

	for (let i = 0; i < MAX_ITERATIONS; i++) {
		if (params.signal.aborted) {
			return;
		}
		params.onAssistantStart();
		const result = await streamMessage(params.apiKey, {
			system,
			maxTokens: 8192,
			messages: params.history,
			tools: AGENT_TOOLS,
			toolChoice: { type: 'auto' }
		}, { onText: params.onText }, params.signal);
		params.onAssistantEnd();
		params.onUsage(result.usage.input, result.usage.output);

		const assistantBlocks: ContentBlock[] = [];
		if (result.text) {
			assistantBlocks.push({ type: 'text', text: result.text });
		}
		for (const tu of result.toolUses) {
			assistantBlocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
		}
		params.history.push({ role: 'assistant', content: assistantBlocks.length ? assistantBlocks : (result.text || '…') });

		if (result.stopReason !== 'tool_use' || result.toolUses.length === 0 || params.signal.aborted) {
			return;
		}

		const toolResults: ContentBlock[] = [];
		for (const tu of result.toolUses) {
			const out = await executeTool(tu.name, tu.input, params);
			params.onTool(toolNote(tu.name, tu.input), out.content);
			toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: out.content, is_error: out.isError });
		}
		params.history.push({ role: 'user', content: toolResults });
	}
}
