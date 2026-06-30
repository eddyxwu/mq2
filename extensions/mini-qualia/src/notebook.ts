/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { MiniQualiaProject, MiniQualiaTask } from './model';

/** The notebook file MiniQualia creates and grounds its work in. */
export const NOTEBOOK_FILENAME = 'analysis.ipynb';

/** A cell to append to the notebook. */
export interface CellSpec {
	kind: 'markdown' | 'code';
	value: string;
}

/** Result of an append operation, used to record provenance on tasks/findings. */
export interface AppendResult {
	startIndex: number;
	indices: number[];
}

/**
 * Serializes notebook mutations and executions. Parallel agents append/execute
 * against the same notebook (one kernel, one document), so these operations must
 * not interleave — each runs to completion before the next begins.
 */
let notebookQueue: Promise<unknown> = Promise.resolve();
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
	const run = notebookQueue.then(fn, fn);
	notebookQueue = run.then(() => undefined, () => undefined);
	return run;
}

/** The empty notebook scaffold written to disk before the serializer takes over. */
const EMPTY_NOTEBOOK = {
	cells: [],
	metadata: {
		kernelspec: {
			display_name: 'Python 3',
			language: 'python',
			name: 'python3'
		},
		language_info: {
			name: 'python',
			pygments_lexer: 'ipython3'
		}
	},
	nbformat: 4,
	nbformat_minor: 5
};

/**
 * Returns the analysis notebook uri, creating an empty notebook on disk if it
 * does not exist yet.
 */
export async function ensureNotebook(workspaceUri: vscode.Uri): Promise<vscode.Uri> {
	const uri = vscode.Uri.joinPath(workspaceUri, NOTEBOOK_FILENAME);
	try {
		await vscode.workspace.fs.stat(uri);
	} catch {
		const json = JSON.stringify(EMPTY_NOTEBOOK, undefined, 1);
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(json));
	}
	return uri;
}

/** Opens the notebook in the notebook editor. */
export async function openNotebook(uri: vscode.Uri): Promise<void> {
	const doc = await vscode.workspace.openNotebookDocument(uri);
	await vscode.window.showNotebookDocument(doc, { preview: false });
}

/**
 * Appends cells to the notebook using a notebook workspace edit, saves to disk,
 * and reveals the newly inserted cells. Returns the indices of the inserted
 * cells so callers can record provenance.
 */
export function appendCells(uri: vscode.Uri, cells: CellSpec[]): Promise<AppendResult> {
	return runExclusive(async () => {
		const doc = await vscode.workspace.openNotebookDocument(uri);
		const startIndex = doc.cellCount;

		const datas = cells.map(cell => new vscode.NotebookCellData(
			cell.kind === 'markdown' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
			cell.value,
			cell.kind === 'markdown' ? 'markdown' : 'python'
		));

		const edit = new vscode.WorkspaceEdit();
		edit.set(uri, [vscode.NotebookEdit.insertCells(startIndex, datas)]);
		const applied = await vscode.workspace.applyEdit(edit);
		if (!applied) {
			throw new Error('Failed to append notebook cells.');
		}
		await doc.save();

		const endIndex = startIndex + datas.length;
		await vscode.window.showNotebookDocument(doc, {
			preview: false,
			selections: [new vscode.NotebookRange(startIndex, endIndex)]
		});

		return { startIndex, indices: datas.map((_, i) => startIndex + i) };
	});
}

/**
 * Executes the given cells (code cells only) using whatever kernel is bound to
 * the notebook, waits for them to finish, and returns true if execution
 * actually ran. Returns false when no kernel produced results within the
 * timeout (the caller then falls back to synthesized findings). Serialized with
 * appends because a single kernel runs cells sequentially.
 */
export function executeCells(uri: vscode.Uri, indices: number[]): Promise<boolean> {
	return runExclusive(async () => {
		const doc = await vscode.workspace.openNotebookDocument(uri);
		const codeIndices = indices.filter(i => i < doc.cellCount && doc.cellAt(i).kind === vscode.NotebookCellKind.Code);
		if (codeIndices.length === 0) {
			return false;
		}
		const start = Math.min(...codeIndices);
		const end = Math.max(...codeIndices) + 1;
		try {
			await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start, end }], document: uri });
		} catch {
			return false;
		}
		return waitForExecution(doc, codeIndices);
	});
}

/** Polls until the target code cells finish executing, or times out. */
async function waitForExecution(doc: vscode.NotebookDocument, indices: number[], timeoutMs = 90_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const done = indices.every(i => {
			const cell = doc.cellAt(i);
			return cell.executionSummary?.success !== undefined || cell.outputs.length > 0;
		});
		if (done) {
			// Any cell with a populated executionSummary means a kernel ran.
			return indices.some(i => doc.cellAt(i).executionSummary?.success !== undefined) || indices.some(i => doc.cellAt(i).outputs.length > 0);
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	return false;
}

/**
 * Reads a cell's outputs and returns the last JSON object printed to it (from a
 * `print(json.dumps({...}))` line), or undefined. This is how realized Q_VARS
 * are captured from executed cells.
 */
export async function readCellResult(uri: vscode.Uri, cellIndex: number): Promise<Record<string, unknown> | undefined> {
	const doc = await vscode.workspace.openNotebookDocument(uri);
	if (cellIndex >= doc.cellCount) {
		return undefined;
	}
	const decoder = new TextDecoder();
	for (const output of doc.cellAt(cellIndex).outputs) {
		for (const item of output.items) {
			const parsed = parseLastJsonObject(decoder.decode(item.data));
			if (parsed) {
				return parsed;
			}
		}
	}
	return undefined;
}

/** Decodes all of a cell's outputs to text (stdout/stderr/errors), truncated. */
export async function readCellText(uri: vscode.Uri, cellIndex: number): Promise<string> {
	const doc = await vscode.workspace.openNotebookDocument(uri);
	if (cellIndex >= doc.cellCount) {
		return '';
	}
	const decoder = new TextDecoder();
	const parts: string[] = [];
	for (const output of doc.cellAt(cellIndex).outputs) {
		for (const item of output.items) {
			parts.push(decoder.decode(item.data));
		}
	}
	const text = parts.join('\n').trim();
	return text.length > 8_000 ? `${text.slice(0, 8_000)}\n…[truncated]` : text;
}

/**
 * Appends a single code cell, executes it, and returns the cell index, whether
 * it succeeded, and its text output. This is the agent's primary way to "do
 * something" — every action appears as an inspectable notebook cell.
 */
export async function runCodeCell(uri: vscode.Uri, code: string): Promise<{ cellIndex: number; ok: boolean; output: string }> {
	const appended = await appendCells(uri, [{ kind: 'code', value: code }]);
	const cellIndex = appended.indices[0];
	const ran = await executeCells(uri, [cellIndex]);
	if (!ran) {
		return { cellIndex, ok: false, output: 'No kernel available — the cell was added but not executed. Select a Python/Jupyter kernel to run it.' };
	}
	const doc = await vscode.workspace.openNotebookDocument(uri);
	const ok = doc.cellAt(cellIndex).executionSummary?.success !== false;
	return { cellIndex, ok, output: await readCellText(uri, cellIndex) || '(no output)' };
}

/** Appends a markdown cell, returning its index. */
export async function appendMarkdownCell(uri: vscode.Uri, markdown: string): Promise<number> {
	const appended = await appendCells(uri, [{ kind: 'markdown', value: markdown }]);
	return appended.indices[0];
}

/** Python that defines a file-backed `Q_VARS` so cells can read upstream values. */
export const QVARS_SHIM = [
	'import json as _json, os as _os',
	'',
	'class _QVars:',
	'    """Read variables captured from upstream tasks (MiniQualia Q_VARS)."""',
	'    _path = _os.path.join(".miniqualia", "qvars.json")',
	'    def get(self, task_ids=None, variable_names=None):',
	'        try:',
	'            data = _json.load(open(self._path))',
	'        except Exception:',
	'            data = {}',
	'        ids = None if task_ids is None else {str(t).split("-", 1)[-1] for t in task_ids}',
	'        out = {}',
	'        for tid, vars in data.items():',
	'            if ids is not None and str(tid).split("-", 1)[-1] not in ids:',
	'                continue',
	'            for k, v in (vars or {}).items():',
	'                if variable_names and k not in variable_names:',
	'                    continue',
	'                out[k] = v',
	'        return out',
	'',
	'Q_VARS = _QVars()',
	'print("Q_VARS ready")'
].join('\n');

/** Appends and runs the Q_VARS setup cell once per notebook, if not already present. */
export async function ensureQvarsSetup(uri: vscode.Uri): Promise<void> {
	const doc = await vscode.workspace.openNotebookDocument(uri);
	for (let i = 0; i < doc.cellCount; i++) {
		if (doc.cellAt(i).document.getText().includes('Q_VARS = _QVars()')) {
			return;
		}
	}
	await appendCells(uri, [
		{ kind: 'markdown', value: '## Setup · Q_VARS\n\n> MiniQualia injects `Q_VARS` so downstream tasks can read variables captured upstream — `Q_VARS.get(task_ids=["T-1"])`.' },
		{ kind: 'code', value: QVARS_SHIM }
	]);
	await executeCells(uri, [doc.cellCount + 1]);
}

/** Persists a task's captured variables to `.miniqualia/qvars.json` for Q_VARS. */
export async function writeQvars(workspaceUri: vscode.Uri, taskId: string, captured: Record<string, unknown>): Promise<void> {
	const dir = vscode.Uri.joinPath(workspaceUri, '.miniqualia');
	const file = vscode.Uri.joinPath(dir, 'qvars.json');
	let data: Record<string, unknown> = {};
	try {
		data = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)));
	} catch {
		// Start fresh.
	}
	data[taskId] = captured;
	await vscode.workspace.fs.createDirectory(dir);
	await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(JSON.stringify(data, undefined, 2)));
}

/** Returns the last line of `text` that parses to a JSON object, if any. */
function parseLastJsonObject(text: string): Record<string, unknown> | undefined {
	const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line.startsWith('{')) {
			continue;
		}
		try {
			const value = JSON.parse(line);
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				return value as Record<string, unknown>;
			}
		} catch {
			// Not JSON; keep scanning.
		}
	}
	return undefined;
}

/** True when the session is the canonical iris model-comparison plan. */
export function isModelComparisonPlan(project: MiniQualiaProject): boolean {
	return project.tasks.some(task => task.id === 'T-6');
}

/**
 * Builds the cells a task should append to the notebook. Iris-demo tasks get
 * runnable scikit-learn cells; any other task gets a documented placeholder.
 * Every task leads with a markdown heading carrying its task id, so provenance
 * is visible directly in the notebook.
 */
export function cellsForTask(project: MiniQualiaProject, task: MiniQualiaTask, agentLabel: string): CellSpec[] {
	const heading: CellSpec = {
		kind: 'markdown',
		value: `## ${task.id} · ${task.title}\n\n> MiniQualia task **${task.id}** — agent **${agentLabel}**\n>\n> ${task.objective}${task.requiredVars?.length ? `\n>\n> Produces (Q_VARS): \`${task.requiredVars.join('`, `')}\`` : ''}`
	};

	// 1. LLM-planned tasks carry their own runnable code.
	if (task.code?.trim()) {
		return [heading, { kind: 'code', value: task.code }];
	}
	// 2. The built-in iris recipe (deterministic model-comparison plan).
	const recipe = isModelComparisonPlan(project) ? IRIS_CODE_CELLS[task.id] : undefined;
	if (recipe) {
		return [heading, ...recipe.map(value => ({ kind: 'code' as const, value }))];
	}
	// 3. Fallback placeholder for generic deterministic plans.
	return [
		heading,
		{
			kind: 'code',
			value: `# ${task.id}: ${task.title}\n# TODO: implement — ${task.objective}\nprint(${JSON.stringify(`${task.id} placeholder cell appended by ${agentLabel}`)})`
		}
	];
}

/**
 * The runnable iris model-comparison recipe, keyed by task id. Each cell builds
 * on the Q_VARS produced by earlier tasks (`X`, `y`, `X_train`, `results`, ...).
 */
const IRIS_CODE_CELLS: Record<string, string[]> = {
	'T-1': [
		[
			'import json',
			'from sklearn.datasets import load_iris',
			'from sklearn.model_selection import train_test_split',
			'',
			'iris = load_iris(as_frame=True)',
			'X = iris.data',
			'y = iris.target',
			'df = iris.frame',
			'# Shared, read-only split so the model tasks can run in any order.',
			'X_train, X_test, y_train, y_test = train_test_split(',
			'    X, y, test_size=0.25, random_state=42, stratify=y',
			')',
			'print(json.dumps({"rows": int(df.shape[0]), "features": int(X.shape[1]), "classes": int(y.nunique())}))'
		].join('\n')
	],
	'T-2': [
		[
			'import json',
			'from sklearn.linear_model import LogisticRegression',
			'from sklearn.metrics import accuracy_score',
			'',
			'logreg = LogisticRegression(max_iter=1000).fit(X_train, y_train)',
			'acc_logreg = float(accuracy_score(y_test, logreg.predict(X_test)))',
			'print(json.dumps({"logistic_regression": round(acc_logreg, 4)}))'
		].join('\n')
	],
	'T-3': [
		[
			'import json',
			'from sklearn.ensemble import RandomForestClassifier',
			'from sklearn.metrics import accuracy_score',
			'',
			'rf = RandomForestClassifier(n_estimators=100, random_state=42).fit(X_train, y_train)',
			'acc_rf = float(accuracy_score(y_test, rf.predict(X_test)))',
			'print(json.dumps({"random_forest": round(acc_rf, 4)}))'
		].join('\n')
	],
	'T-4': [
		[
			'import json',
			'from sklearn.svm import SVC',
			'from sklearn.metrics import accuracy_score',
			'',
			'svm = SVC(kernel="rbf", probability=True, random_state=42).fit(X_train, y_train)',
			'acc_svm = float(accuracy_score(y_test, svm.predict(X_test)))',
			'print(json.dumps({"svm": round(acc_svm, 4)}))'
		].join('\n')
	],
	'T-5': [
		[
			'import json',
			'',
			'# Q_VARS that flow to the writeup task.',
			'results = {"logistic_regression": acc_logreg, "random_forest": acc_rf, "svm": acc_svm}',
			'best_model = max(results, key=results.get)',
			'best_accuracy = results[best_model]',
			'print(json.dumps({',
			'    "results": {k: round(v, 4) for k, v in results.items()},',
			'    "best_model": best_model,',
			'    "best_accuracy": round(float(best_accuracy), 4)',
			'}))'
		].join('\n')
	],
	'T-6': [
		[
			'import json',
			'# T-6 exports a sourced Markdown writeup from the captured findings.',
			'# In Qualia this is where Q_VARS.get("best_model") would be substituted',
			'# into the narrative; MiniQualia writes miniqualia-writeup.md from state.',
			'print(json.dumps({"writeup": "miniqualia-writeup.md", "best_model": best_model}))'
		].join('\n')
	]
};
