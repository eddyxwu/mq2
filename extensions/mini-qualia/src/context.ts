/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEFAULT_SKILLS } from './model';

/**
 * Loads the persistent context that shapes the agent — workspace **rules**
 * (CLAUDE.md / AGENTS.md / MINIQUALIA.md) and **skills** (built-in plus
 * `.claude/skills`, `.claude/commands`, and Cursor skills) — mirroring Qualia's
 * Rules and Skills systems.
 */

/** A reusable workflow the agent can follow (Qualia "Skill"). */
export interface LoadedSkill {
	name: string;
	slashCommand: string;
	description: string;
	instructions: string;
	autoInvoke: boolean;
	source: string;
}

const decoder = new TextDecoder();

async function readText(uri: vscode.Uri): Promise<string | undefined> {
	try {
		return decoder.decode(await vscode.workspace.fs.readFile(uri));
	} catch {
		return undefined;
	}
}

async function readDir(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
	try {
		return await vscode.workspace.fs.readDirectory(uri);
	} catch {
		return [];
	}
}

/**
 * Concatenates workspace rules files into a single instruction block, or ''.
 * CLAUDE.md and AGENTS.md are recognized like Qualia's workspace rules.
 */
export async function loadRules(workspaceUri?: vscode.Uri): Promise<string> {
	if (!workspaceUri) {
		return '';
	}
	const sections: string[] = [];

	for (const name of ['CLAUDE.md', 'AGENTS.md', 'MINIQUALIA.md']) {
		const content = await readText(vscode.Uri.joinPath(workspaceUri, name));
		if (content?.trim()) {
			sections.push(`### Workspace rules — ${name}\n${content.trim()}`);
		}
	}

	const rulesDir = vscode.Uri.joinPath(workspaceUri, '.miniqualia', 'rules');
	for (const [file, type] of await readDir(rulesDir)) {
		if (type === vscode.FileType.File && file.toLowerCase().endsWith('.md')) {
			const content = await readText(vscode.Uri.joinPath(rulesDir, file));
			if (content?.trim()) {
				sections.push(`### Rule — ${file}\n${content.trim()}`);
			}
		}
	}

	return sections.join('\n\n');
}

/** Parses optional YAML-ish frontmatter (name/description) from a SKILL.md. */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
	if (!match) {
		return { meta: {}, body: text };
	}
	const meta: Record<string, string> = {};
	for (const line of match[1].split('\n')) {
		const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
		if (kv) {
			meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim();
		}
	}
	return { meta, body: match[2] };
}

function firstHeadingOrLine(body: string): string {
	for (const line of body.split('\n')) {
		const t = line.replace(/^#+\s*/, '').trim();
		if (t) {
			return t.slice(0, 140);
		}
	}
	return '';
}

function toSkill(name: string, body: string, meta: Record<string, string>, source: string): LoadedSkill {
	const clean = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
	return {
		name: meta.name || clean,
		slashCommand: `/${meta.name || clean}`,
		description: meta.description || firstHeadingOrLine(body) || clean,
		instructions: body.trim(),
		autoInvoke: meta['auto-invoke'] !== 'false' && meta.autoinvoke !== 'false',
		source
	};
}

/** Scans `base/skills/<name>/SKILL.md` and `base/commands/<name>.md` for skills. */
async function scanSkillDir(base: vscode.Uri, source: string): Promise<LoadedSkill[]> {
	const found: LoadedSkill[] = [];

	const skillsDir = vscode.Uri.joinPath(base, 'skills');
	for (const [entry, type] of await readDir(skillsDir)) {
		if (type === vscode.FileType.Directory) {
			const body = await readText(vscode.Uri.joinPath(skillsDir, entry, 'SKILL.md'));
			if (body) {
				const { meta, body: text } = parseFrontmatter(body);
				found.push(toSkill(entry, text, meta, source));
			}
		}
	}

	const commandsDir = vscode.Uri.joinPath(base, 'commands');
	for (const [entry, type] of await readDir(commandsDir)) {
		if (type === vscode.FileType.File && entry.toLowerCase().endsWith('.md')) {
			const body = await readText(vscode.Uri.joinPath(commandsDir, entry));
			if (body) {
				const { meta, body: text } = parseFrontmatter(body);
				found.push(toSkill(entry.replace(/\.md$/i, ''), text, meta, source));
			}
		}
	}

	return found;
}

/**
 * Returns all available skills: built-in defaults plus any imported from
 * `.claude` (workspace and home) and Cursor, de-duplicated by name.
 */
export async function loadSkills(workspaceUri?: vscode.Uri): Promise<LoadedSkill[]> {
	const skills: LoadedSkill[] = DEFAULT_SKILLS.map(s => ({
		name: s.name.toLowerCase().replace(/\s+/g, '-'),
		slashCommand: s.slashCommand,
		description: s.description,
		instructions: s.template,
		autoInvoke: true,
		source: 'built-in'
	}));

	const home = vscode.Uri.file(os.homedir());
	const sources: Array<[vscode.Uri, string]> = [
		[home, 'claude-code (home)'],
		[vscode.Uri.joinPath(home, '.cursor'), 'cursor'],
		[home, 'claude-code']
	];
	if (workspaceUri) {
		sources.unshift([vscode.Uri.joinPath(workspaceUri, '.claude'), 'claude-code (workspace)']);
	}
	// Home `.claude` lives under ~/.claude, so target that explicitly too.
	sources.push([vscode.Uri.joinPath(home, '.claude'), 'claude-code (home)']);

	const seen = new Set(skills.map(s => s.name));
	for (const [base, source] of sources) {
		for (const skill of await scanSkillDir(base, source)) {
			if (!seen.has(skill.name)) {
				seen.add(skill.name);
				skills.push(skill);
			}
		}
	}
	return skills;
}

/** Finds a skill by name or slash command (case-insensitive). */
export function findSkill(skills: LoadedSkill[], name: string): LoadedSkill | undefined {
	const n = name.replace(/^\//, '').toLowerCase();
	return skills.find(s => s.name.toLowerCase() === n || s.slashCommand.toLowerCase() === `/${n}`);
}

/** A short label for where the skills/rules config lives, for messages. */
export function configHint(): string {
	return path.join(os.homedir(), '.claude', 'skills');
}
