/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * A minimal Anthropic Messages API client built on the global `fetch` (Node 18+),
 * so the extension needs no bundled SDK dependency. Supports both a single
 * request/response and SSE streaming, plus tool use for structured output.
 *
 * Endpoint and headers follow the public API: POST /v1/messages with
 * `x-api-key` and `anthropic-version: 2023-06-01`.
 */

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-opus-4-8';

export type LlmRole = 'user' | 'assistant';

export interface TextBlock { type: 'text'; text: string }
export interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }
export interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface LlmMessage {
	role: LlmRole;
	content: string | ContentBlock[];
}

export interface ToolDefinition {
	name: string;
	description: string;
	input_schema: object;
}

export type ToolChoice = { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string };

export interface CreateMessageParams {
	system?: string;
	messages: LlmMessage[];
	maxTokens: number;
	tools?: ToolDefinition[];
	toolChoice?: ToolChoice;
	model?: string;
}

/** The normalized result of a message request. */
export interface MessageResult {
	stopReason: string | null;
	text: string;
	toolUses: Array<{ id: string; name: string; input: unknown }>;
	usage: { input: number; output: number };
}

/** Streaming callbacks. */
export interface StreamHandlers {
	onText?: (delta: string) => void;
	onToolUse?: (name: string) => void;
}

/** Error raised when the Anthropic API rejects a request. */
export class AnthropicError extends Error {
	constructor(message: string, readonly status?: number, readonly apiType?: string) {
		super(message);
		this.name = 'AnthropicError';
	}
}

/** Reads the configured model from settings, defaulting to Claude Opus 4.8. */
export function getConfiguredModel(): string {
	return vscode.workspace.getConfiguration('miniQualia').get<string>('model') || DEFAULT_MODEL;
}

function buildBody(params: CreateMessageParams, stream: boolean): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: params.model || getConfiguredModel(),
		max_tokens: params.maxTokens,
		messages: params.messages,
		stream
	};
	if (params.system) {
		body.system = params.system;
	}
	if (params.tools?.length) {
		body.tools = params.tools;
	}
	if (params.toolChoice) {
		body.tool_choice = params.toolChoice;
	}
	return body;
}

function headers(apiKey: string): Record<string, string> {
	return {
		'x-api-key': apiKey,
		'anthropic-version': ANTHROPIC_VERSION,
		'content-type': 'application/json'
	};
}

/** Turns an HTTP error response into a friendly AnthropicError. */
async function toError(response: Response): Promise<AnthropicError> {
	let detail = '';
	let apiType: string | undefined;
	try {
		const json = await response.json() as { error?: { message?: string; type?: string } };
		detail = json.error?.message ?? '';
		apiType = json.error?.type;
	} catch {
		// Non-JSON error body.
	}
	const friendly = response.status === 401
		? 'Invalid or missing Anthropic API key. Run "MiniQualia: Set Anthropic API Key".'
		: response.status === 429
			? 'Anthropic rate limit reached. Try again shortly.'
			: detail || `Anthropic API error (${response.status}).`;
	return new AnthropicError(friendly, response.status, apiType);
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** POSTs to the Messages API, retrying transient 429/5xx errors with backoff. */
async function postWithRetry(apiKey: string, params: CreateMessageParams, stream: boolean, signal?: AbortSignal): Promise<Response> {
	const body = JSON.stringify(buildBody(params, stream));
	let lastError: AnthropicError | undefined;
	for (let attempt = 0; attempt < 4; attempt++) {
		const response = await fetch(ENDPOINT, { method: 'POST', headers: headers(apiKey), body, signal });
		if (response.ok) {
			return response;
		}
		if (![429, 500, 502, 503, 529].includes(response.status)) {
			throw await toError(response);
		}
		lastError = await toError(response);
		const retryAfter = Number(response.headers.get('retry-after'));
		await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 600 * Math.pow(2, attempt));
	}
	throw lastError ?? new AnthropicError('Anthropic API request failed after retries.');
}

/** Sends one message and returns the assembled text and any tool-use blocks. */
export async function createMessage(apiKey: string, params: CreateMessageParams, signal?: AbortSignal): Promise<MessageResult> {
	const response = await postWithRetry(apiKey, params, false, signal);
	const json = await response.json() as {
		stop_reason: string | null;
		content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
		usage?: { input_tokens?: number; output_tokens?: number };
	};
	const result: MessageResult = { stopReason: json.stop_reason, text: '', toolUses: [], usage: { input: json.usage?.input_tokens ?? 0, output: json.usage?.output_tokens ?? 0 } };
	for (const block of json.content) {
		if (block.type === 'text' && block.text) {
			result.text += block.text;
		} else if (block.type === 'tool_use' && block.id && block.name) {
			result.toolUses.push({ id: block.id, name: block.name, input: block.input ?? {} });
		}
	}
	return result;
}

/**
 * Streams a message, invoking handlers as text and tool calls arrive, and
 * returns the fully assembled result once the stream ends.
 */
export async function streamMessage(apiKey: string, params: CreateMessageParams, handlers: StreamHandlers = {}, signal?: AbortSignal): Promise<MessageResult> {
	const response = await postWithRetry(apiKey, params, true, signal);
	if (!response.body) {
		throw new AnthropicError('Anthropic streaming response had no body.');
	}

	const result: MessageResult = { stopReason: null, text: '', toolUses: [], usage: { input: 0, output: 0 } };
	// Per-content-block accumulation, keyed by stream index.
	const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	const handleEvent = (data: string) => {
		let event: {
			type: string;
			index?: number;
			content_block?: { type: string; id?: string; name?: string };
			delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
			message?: { usage?: { input_tokens?: number } };
			usage?: { output_tokens?: number };
		};
		try {
			event = JSON.parse(data);
		} catch {
			return;
		}
		switch (event.type) {
			case 'message_start':
				if (event.message?.usage?.input_tokens) {
					result.usage.input = event.message.usage.input_tokens;
				}
				break;
			case 'content_block_start':
				if (event.index !== undefined && event.content_block) {
					blocks.set(event.index, { type: event.content_block.type, id: event.content_block.id, name: event.content_block.name, json: '' });
					if (event.content_block.type === 'tool_use' && event.content_block.name) {
						handlers.onToolUse?.(event.content_block.name);
					}
				}
				break;
			case 'content_block_delta':
				if (event.delta?.type === 'text_delta' && event.delta.text) {
					result.text += event.delta.text;
					handlers.onText?.(event.delta.text);
				} else if (event.delta?.type === 'input_json_delta' && event.index !== undefined) {
					const block = blocks.get(event.index);
					if (block) {
						block.json += event.delta.partial_json ?? '';
					}
				}
				break;
			case 'message_delta':
				if (event.delta?.stop_reason) {
					result.stopReason = event.delta.stop_reason;
				}
				if (event.usage?.output_tokens) {
					result.usage.output = event.usage.output_tokens;
				}
				break;
		}
	};

	for (; ;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		let nl: number;
		while ((nl = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (line.startsWith('data:')) {
				handleEvent(line.slice(5).trim());
			}
		}
	}

	for (const block of blocks.values()) {
		if (block.type === 'tool_use' && block.id && block.name) {
			let input: unknown = {};
			try {
				input = block.json ? JSON.parse(block.json) : {};
			} catch {
				input = {};
			}
			result.toolUses.push({ id: block.id, name: block.name, input });
		}
	}

	return result;
}
