/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { MiniQualiaAgent, MiniQualiaFinding, MiniQualiaProject, MiniQualiaTask } from './model';

/**
 * Holds the active research session and persists it to `.miniqualia/state.json`
 * in the workspace folder. The on-disk file is intentionally human-readable so
 * the data model is easy to inspect and explain.
 *
 * The store is the single source of truth in the extension: views subscribe to
 * {@link onDidChange} and re-render whenever the session is mutated.
 */
export class MiniQualiaStore implements vscode.Disposable {

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	/** Fires whenever the persisted session changes. */
	readonly onDidChange = this._onDidChange.event;

	private _project: MiniQualiaProject | undefined;

	private readonly _dirUri: vscode.Uri | undefined;
	private readonly _stateUri: vscode.Uri | undefined;

	constructor(private readonly workspaceFolder: vscode.WorkspaceFolder | undefined) {
		if (workspaceFolder) {
			this._dirUri = vscode.Uri.joinPath(workspaceFolder.uri, '.miniqualia');
			this._stateUri = vscode.Uri.joinPath(this._dirUri, 'state.json');
		}
	}

	get project(): MiniQualiaProject | undefined {
		return this._project;
	}

	/** True when a workspace folder is open to persist state into. */
	get hasWorkspace(): boolean {
		return !!this.workspaceFolder;
	}

	get workspaceUri(): vscode.Uri {
		if (!this.workspaceFolder) {
			throw new Error('MiniQualia requires an open folder.');
		}
		return this.workspaceFolder.uri;
	}

	/** Loads the session from disk, if one exists. Does not fire a change event. */
	async load(): Promise<void> {
		if (!this._stateUri) {
			return;
		}
		try {
			const bytes = await vscode.workspace.fs.readFile(this._stateUri);
			this._project = JSON.parse(new TextDecoder().decode(bytes)) as MiniQualiaProject;
		} catch {
			// No state file yet, or unreadable: start empty.
			this._project = undefined;
		}
	}

	/**
	 * Replaces the active session and persists it. Used when starting or
	 * resetting a research session.
	 */
	async setProject(project: MiniQualiaProject | undefined): Promise<void> {
		this._project = project;
		if (project) {
			await this.save();
		} else {
			await this.deleteStateFile();
		}
		this._onDidChange.fire();
	}

	/**
	 * Applies a mutation to the active session, bumps the timestamp, persists,
	 * and notifies listeners. No-op when there is no active session.
	 */
	async mutate(fn: (project: MiniQualiaProject) => void): Promise<void> {
		if (!this._project) {
			return;
		}
		fn(this._project);
		this._project.updatedAt = nowIso();
		await this.save();
		this._onDidChange.fire();
	}

	/** Appends an activity-log entry (used by the simulated autonomous mode). */
	async appendLog(actor: string, message: string): Promise<void> {
		await this.mutate(project => {
			project.log.push({ at: nowIso(), actor, message });
		});
	}

	taskById(id: string): MiniQualiaTask | undefined {
		return this._project?.tasks.find(t => t.id === id);
	}

	agentById(id: string): MiniQualiaAgent | undefined {
		return this._project?.agents.find(a => a.id === id);
	}

	/** Returns the next free finding id (`K-1`, `K-2`, ...). */
	nextFindingId(): string {
		const findings = this._project?.findings ?? [];
		let max = 0;
		for (const finding of findings) {
			const match = /^K-(\d+)$/.exec(finding.id);
			if (match) {
				max = Math.max(max, Number(match[1]));
			}
		}
		return `K-${max + 1}`;
	}

	private async save(): Promise<void> {
		if (!this._dirUri || !this._stateUri) {
			return;
		}
		await vscode.workspace.fs.createDirectory(this._dirUri);
		const json = JSON.stringify(this._project, undefined, 2);
		await vscode.workspace.fs.writeFile(this._stateUri, new TextEncoder().encode(json));
	}

	private async deleteStateFile(): Promise<void> {
		if (!this._stateUri) {
			return;
		}
		try {
			await vscode.workspace.fs.delete(this._stateUri);
		} catch {
			// Already gone.
		}
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}

/** Returns the current time as an ISO 8601 string. */
export function nowIso(): string {
	return new Date().toISOString();
}

/** Convenience factory used when (re)starting a session. */
export function createFinding(partial: Omit<MiniQualiaFinding, 'createdAt'>): MiniQualiaFinding {
	return { ...partial, createdAt: nowIso() };
}
