/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** SecretStorage key under which the Anthropic API key is persisted. */
const SECRET_KEY = 'miniQualia.anthropicApiKey';

/**
 * Returns the Anthropic API key, preferring a key stored in VS Code's
 * SecretStorage and falling back to the `ANTHROPIC_API_KEY` environment
 * variable. Returns undefined when no key is configured.
 */
export async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
	const stored = await context.secrets.get(SECRET_KEY);
	return stored || process.env.ANTHROPIC_API_KEY || undefined;
}

/** True when an API key is available from either source. */
export async function hasApiKey(context: vscode.ExtensionContext): Promise<boolean> {
	return !!(await getApiKey(context));
}

/**
 * Prompts for an Anthropic API key and stores it in SecretStorage.
 * Returns the stored key, or undefined if the user cancelled.
 */
export async function setApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
	const key = await vscode.window.showInputBox({
		title: 'MiniQualia: Anthropic API Key',
		prompt: 'Paste your Anthropic API key. It is stored securely in VS Code SecretStorage.',
		placeHolder: 'sk-ant-...',
		password: true,
		ignoreFocusOut: true
	});
	if (!key) {
		return undefined;
	}
	await context.secrets.store(SECRET_KEY, key.trim());
	return key.trim();
}

/** Removes the stored API key (the env-var fallback, if any, still applies). */
export async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
	await context.secrets.delete(SECRET_KEY);
}
