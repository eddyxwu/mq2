/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { MiniQualiaFinding } from './model';
import { executeCells } from './notebook';
import { nowIso, MiniQualiaStore } from './storage';
import { recordFinding } from './writeup';

/**
 * The Knowledge system's validation and import operations, mirroring Qualia's
 * "Validate" / "Validate upstream" and "Import Knowledge".
 */

export interface ValidationResult {
	ok: boolean;
	message: string;
}

/**
 * Re-runs a claim's source cell and flags the claim stale if its evidence now
 * errors. Notebook-captured claims "mirror the evidence" — when the cell
 * changes, the claim is revalidated.
 */
export async function validateFinding(store: MiniQualiaStore, findingId: string): Promise<ValidationResult> {
	const finding = store.project?.findings.find(f => f.id === findingId);
	if (!finding) {
		return { ok: false, message: `Claim ${findingId} not found.` };
	}
	const source = finding.source;
	if (source.type !== 'notebook-cell' || source.uri === undefined || source.cellIndex === undefined) {
		await markValidated(store, findingId, false);
		return { ok: true, message: `${findingId} has no re-runnable source; marked reviewed.` };
	}

	const uri = vscode.Uri.parse(source.uri);
	const ran = await executeCells(uri, [source.cellIndex]);
	if (!ran) {
		return { ok: false, message: 'No kernel available to validate against. Select a kernel and retry.' };
	}
	const doc = await vscode.workspace.openNotebookDocument(uri);
	const stale = source.cellIndex < doc.cellCount && doc.cellAt(source.cellIndex).executionSummary?.success === false;
	await markValidated(store, findingId, stale);
	return { ok: !stale, message: stale ? `${findingId} is STALE — its source cell now errors.` : `${findingId} validated against current evidence.` };
}

/** Validates a claim and every claim it builds on (claim graph + task deps). */
export async function validateUpstream(store: MiniQualiaStore, findingId: string): Promise<ValidationResult> {
	const seen = new Set<string>();
	const queue = [findingId];
	let staleCount = 0;
	let checked = 0;
	while (queue.length) {
		const id = queue.shift() as string;
		if (seen.has(id)) {
			continue;
		}
		seen.add(id);
		const finding = store.project?.findings.find(f => f.id === id);
		if (!finding) {
			continue;
		}
		const result = await validateFinding(store, id);
		checked++;
		if (!result.ok && /STALE/.test(result.message)) {
			staleCount++;
		}
		for (const related of finding.relatedClaimIds ?? []) {
			queue.push(related);
		}
	}
	return { ok: staleCount === 0, message: `Validated ${checked} claim(s) upstream — ${staleCount} stale.` };
}

async function markValidated(store: MiniQualiaStore, findingId: string, stale: boolean): Promise<void> {
	await store.mutate(p => {
		const f = p.findings.find(x => x.id === findingId);
		if (f) {
			f.stale = stale;
			f.validatedAt = nowIso();
		}
	});
}

/**
 * Imports external knowledge from a Markdown or JSON file as synthesized claims.
 * JSON: an array of strings or `{claim, highLevel?, metric?}`. Markdown: each
 * heading/bullet/paragraph becomes a claim.
 */
export async function importKnowledge(store: MiniQualiaStore, uri: vscode.Uri): Promise<MiniQualiaFinding[]> {
	const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
	const items: Array<{ claim: string; highLevel?: boolean; metric?: number }> = [];

	if (uri.path.toLowerCase().endsWith('.json')) {
		const parsed = JSON.parse(text);
		const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.claims) ? parsed.claims : [];
		for (const entry of arr) {
			if (typeof entry === 'string') {
				items.push({ claim: entry });
			} else if (entry && typeof entry.claim === 'string') {
				items.push({ claim: entry.claim, highLevel: !!entry.highLevel, metric: typeof entry.metric === 'number' ? entry.metric : undefined });
			}
		}
	} else {
		for (const raw of text.split('\n')) {
			const line = raw.replace(/^\s*([-*]|\d+\.)\s+/, '').replace(/^#+\s*/, '').trim();
			if (line.length > 8 && !line.startsWith('```')) {
				items.push({ claim: line, highLevel: raw.trim().startsWith('#') });
			}
		}
	}

	const created: MiniQualiaFinding[] = [];
	for (const item of items.slice(0, 100)) {
		created.push(await recordFinding(store, {
			kind: 'synthesized',
			claim: item.claim,
			summary: `Imported from ${uri.path.split('/').pop()}.`,
			source: { type: 'file', uri: uri.toString() },
			highLevel: item.highLevel,
			metric: item.metric
		}));
	}
	return created;
}
