import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugLogger } from "../src/providers/kiro/vendor/debug-logger.js";
import { createKiroStream } from "../src/providers/kiro/vendor/kiro.js";

/**
 * CodeWhisperer rejects a toolUseId outside [A-Za-z0-9_-]{1,64} with HTTP 400
 * `{"message":"Invalid tool use format.","reason":"REQUEST_BODY_INVALID"}`.
 * Verified against the live endpoint (LAB-66): a pipe fails at any length, a
 * 65-character all-legal id fails, and 64 legal characters pass.
 */
const CODEX_TOOL_CALL_ID = "call_yZ3rXnjQ2yuw2copxOlOMWEq|fc_07328a5caee93887016a8f628e6c8087d0a3a7d1872c4021f4";
const KIRO_TOOL_USE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

interface CapturedRequest {
	conversationState: {
		currentMessage: {
			userInputMessage: {
				userInputMessageContext?: { toolResults?: Array<{ toolUseId: string }> };
			};
		};
		history: Array<
			| { assistantResponseMessage: { toolUses?: Array<{ toolUseId: string }> } }
			| { userInputMessage: { userInputMessageContext?: { toolResults?: Array<{ toolUseId: string }> } } }
		>;
	};
}

function model(): Model<Api> {
	return {
		id: "claude-opus-5",
		name: "Claude Opus 5",
		api: "kiro-codewhisperer",
		provider: "kiro",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 32_000,
	};
}

function contextWithToolIds(toolCallId: string): Context {
	return {
		messages: [
			{ role: "user", content: "run echo lab66", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "echo lab66" } }],
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-5.6-sol",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
			{ role: "toolResult", toolCallId, content: "lab66", isError: false, timestamp: 3 },
		],
	} as unknown as Context;
}

/** Run one turn against a captured fetch and return the posted request body. */
async function captureRequest(context: Context): Promise<CapturedRequest> {
	let captured: CapturedRequest | undefined;
	globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
		captured = JSON.parse(String(init?.body)) as CapturedRequest;
		return new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }), { status: 200 });
	}) as unknown as typeof globalThis.fetch;

	const logger = new DebugLogger({ extensionRoot: "/tmp/omo-accounts-test", debug: false });
	const stream = createKiroStream(
		{
			providerId: "kiro",
			upstreamUrl: "https://example.invalid/generate",
			endpoint: "codewhisperer",
			apiKey: "managed",
			requestTimeoutMs: 1_000,
			headers: {},
		},
		{},
		logger,
	)(model(), context, { apiKey: "access-token" });
	for await (const _event of stream as unknown as AsyncIterable<unknown>) {
		// drain
	}
	if (!captured) throw new Error("no request captured");
	return captured;
}

function toolUseIds(request: CapturedRequest): { uses: string[]; results: string[] } {
	const uses: string[] = [];
	const results: string[] = [];
	for (const entry of [...request.conversationState.history, request.conversationState.currentMessage]) {
		if ("assistantResponseMessage" in entry) {
			for (const use of entry.assistantResponseMessage.toolUses ?? []) uses.push(use.toolUseId);
			continue;
		}
		for (const result of entry.userInputMessage.userInputMessageContext?.toolResults ?? []) results.push(result.toolUseId);
	}
	return { uses, results };
}

describe("Kiro toolUseId compatibility", () => {
	it("rewrites a foreign provider's tool id into the CodeWhisperer charset", async () => {
		const { uses, results } = toolUseIds(await captureRequest(contextWithToolIds(CODEX_TOOL_CALL_ID)));

		expect(uses).toHaveLength(1);
		expect(results).toHaveLength(1);
		for (const id of [...uses, ...results]) expect(id).toMatch(KIRO_TOOL_USE_ID);
	});

	it("keeps a tool call and its result on the same id", async () => {
		const { uses, results } = toolUseIds(await captureRequest(contextWithToolIds(CODEX_TOOL_CALL_ID)));

		expect(results[0]).toBe(uses[0]);
	});

	it("posts a Kiro-native id unchanged", async () => {
		const { uses, results } = toolUseIds(await captureRequest(contextWithToolIds("toolu_01ABCdef-xyz_9")));

		expect(uses).toEqual(["toolu_01ABCdef-xyz_9"]);
		expect(results).toEqual(["toolu_01ABCdef-xyz_9"]);
	});

	it("rewrites an id that is legal but too long", async () => {
		const tooLong = "a".repeat(65);
		const { uses } = toolUseIds(await captureRequest(contextWithToolIds(tooLong)));

		expect(uses[0]).not.toBe(tooLong);
		expect(uses[0]).toMatch(KIRO_TOOL_USE_ID);
	});

	it("maps distinct source ids to distinct rewritten ids", async () => {
		const first = toolUseIds(await captureRequest(contextWithToolIds("call_one|fc_one")));
		const second = toolUseIds(await captureRequest(contextWithToolIds("call_two|fc_two")));

		expect(first.uses[0]).not.toBe(second.uses[0]);
	});
});
