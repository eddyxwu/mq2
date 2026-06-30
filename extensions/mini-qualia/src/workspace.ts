/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

/**
 * Workspace file/shell tools that give the agent a Cursor-like surface over the
 * real project: list, read, grep, write, edit, and run commands. All paths are
 * resolved relative to the workspace root.
 */

const execAsync = promisify(exec);
const MAX_READ_BYTES = 200_000;
const MAX_OUTPUT_CHARS = 20_000;
const GREP_MAX_MATCHES = 200;
const GREP_MAX_FILES = 4_000;

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.miniqualia', 'out', 'dist', '.ipynb_checkpoints', '.mypy_cache', '.pytest_cache']);
const TEXT_EXTENSIONS = new Set(['.py', '.ipynb', '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.cfg', '.ini', '.js', '.ts', '.tsx', '.jsx', '.r', '.jl', '.sh', '.csv', '.tsv', '.html', '.css', '.qua']);

let outputChannel: vscode.OutputChannel | undefined;
function channel(): vscode.OutputChannel {
	if (!outputChannel) {
		outputChannel = vscode.window.createOutputChannel('MiniQualia Agent');
	}
	return outputChannel;
}

/** Resolves a (possibly relative) path against the workspace root. */
function resolve(root: vscode.Uri, p: string): vscode.Uri {
	if (path.isAbsolute(p)) {
		return vscode.Uri.file(p);
	}
	return vscode.Uri.joinPath(root, p);
}

function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
	return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
}

/** Lists the entries of a directory (relative to the workspace root). */
export async function listDir(root: vscode.Uri, dir: string): Promise<string> {
	const uri = resolve(root, dir || '.');
	const entries = await vscode.workspace.fs.readDirectory(uri);
	if (entries.length === 0) {
		return '(empty)';
	}
	return entries
		.filter(([name]) => name !== '.miniqualia')
		.sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
		.map(([name, type]) => (type === vscode.FileType.Directory ? `${name}/` : name))
		.join('\n');
}

/** Reads a text file (relative to the workspace root). */
export async function readFile(root: vscode.Uri, file: string): Promise<string> {
	const uri = resolve(root, file);
	const bytes = await vscode.workspace.fs.readFile(uri);
	const text = new TextDecoder().decode(bytes.length > MAX_READ_BYTES ? bytes.slice(0, MAX_READ_BYTES) : bytes);
	return truncate(text, MAX_READ_BYTES);
}

/** Writes a text file (relative to the workspace root); creates parent dirs. */
export async function writeFile(root: vscode.Uri, file: string, content: string): Promise<string> {
	const uri = resolve(root, file);
	const dir = vscode.Uri.joinPath(uri, '..');
	await vscode.workspace.fs.createDirectory(dir);
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
	return `Wrote ${content.length} chars to ${file}.`;
}

/** Replaces the first occurrence of `find` with `replace` in a file. */
export async function editFile(root: vscode.Uri, file: string, find: string, replace: string): Promise<string> {
	const uri = resolve(root, file);
	const original = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
	if (!original.includes(find)) {
		throw new Error(`The text to replace was not found in ${file}.`);
	}
	const updated = original.replace(find, replace);
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(updated));
	return `Edited ${file}.`;
}

/** Recursively searches text files for a regex, returning file:line matches. */
export async function grepSearch(root: vscode.Uri, query: string, dir = '.'): Promise<string> {
	let regex: RegExp;
	try {
		regex = new RegExp(query, 'i');
	} catch {
		regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
	}

	const matches: string[] = [];
	let filesScanned = 0;
	const decoder = new TextDecoder();

	const walk = async (current: vscode.Uri, rel: string): Promise<void> => {
		if (matches.length >= GREP_MAX_MATCHES || filesScanned >= GREP_MAX_FILES) {
			return;
		}
		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(current);
		} catch {
			return;
		}
		for (const [name, type] of entries) {
			if (matches.length >= GREP_MAX_MATCHES || filesScanned >= GREP_MAX_FILES) {
				return;
			}
			const childRel = rel ? `${rel}/${name}` : name;
			if (type === vscode.FileType.Directory) {
				if (!SKIP_DIRS.has(name)) {
					await walk(vscode.Uri.joinPath(current, name), childRel);
				}
			} else if (TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())) {
				filesScanned++;
				try {
					const text = decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(current, name)));
					const lines = text.split('\n');
					for (let i = 0; i < lines.length && matches.length < GREP_MAX_MATCHES; i++) {
						if (regex.test(lines[i])) {
							matches.push(`${childRel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
						}
					}
				} catch {
					// Skip unreadable/binary files.
				}
			}
		}
	};

	await walk(resolve(root, dir), dir === '.' ? '' : dir);
	return matches.length ? matches.join('\n') : `No matches for /${query}/.`;
}

/** True when shell commands are permitted (setting; default on). */
export function shellAllowed(): boolean {
	return vscode.workspace.getConfiguration('miniQualia').get<boolean>('allowShellCommands') !== false;
}

/**
 * Runs a shell command in the workspace root and returns combined output.
 * Echoes to the "MiniQualia Agent" output channel for visibility.
 */
export async function runCommand(root: vscode.Uri, command: string, signal?: AbortSignal): Promise<string> {
	if (!shellAllowed()) {
		return 'Shell commands are disabled (set miniQualia.allowShellCommands to true to enable).';
	}
	const ch = channel();
	ch.appendLine(`$ ${command}`);
	ch.show(true);
	try {
		const { stdout, stderr } = await execAsync(command, {
			cwd: root.fsPath,
			timeout: 120_000,
			maxBuffer: 10 * 1024 * 1024,
			env: { ...process.env },
			signal
		});
		const out = `${stdout || ''}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim() || '(no output)';
		ch.appendLine(truncate(out, 4_000));
		return truncate(out);
	} catch (e) {
		const err = e as { stdout?: string; stderr?: string; message?: string; code?: number };
		const out = `${err.stdout || ''}${err.stderr || ''}`.trim();
		const result = `Command exited with code ${err.code ?? '?'}.\n${truncate(out || err.message || 'failed')}`;
		ch.appendLine(result);
		return result;
	}
}
