import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUsageReport } from "../src/core/usage.js";

const dirs: string[] = [];

function sandbox(auth: Record<string, unknown>, poolState?: Record<string, unknown>): string {
	const agentDir = mkdtempSync(join(tmpdir(), "omo-accounts-stock-status-"));
	dirs.push(agentDir);
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify(auth));
	if (poolState) writeFileSync(join(agentDir, "credential-pool-state.json"), JSON.stringify(poolState));
	return agentDir;
}

const ctx = (agentDir: string) => ({ env: {} as NodeJS.ProcessEnv, agentDir });

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("stock subscription account status", () => {
	it("reports Claude and Codex slots with health but never credential material", async () => {
		// Given: two stored slots per supported stock OAuth provider.
		const agentDir = sandbox(
			{
				"claude-sdk-oauth": {
					type: "oauth",
					access: "claude-sdk-oauth-managed",
					refresh: "claude-sdk-oauth-managed",
					expires: 4_102_444_800_000,
					pinned: "default",
					accounts: [
						{ name: "default", source: "login", access: "secret-claude-a", refresh: "secret-claude-r", expires: 4_102_444_800_000 },
						{ name: "login-2", source: "login", access: "secret-claude-b", refresh: "secret-claude-s", expires: 4_102_444_800_000 },
					],
				},
				"openai-codex": {
					type: "oauth",
					access: "secret-codex-flat",
					refresh: "secret-codex-refresh",
					expires: 4_102_444_800_000,
					pinned: "work",
					accounts: [
						{ name: "default", source: "login", access: "secret-codex-a", refresh: "secret-codex-r", expires: 4_102_444_800_000 },
						{ name: "work", source: "login", access: "secret-codex-b", refresh: "secret-codex-s", expires: 4_102_444_800_000 },
					],
				},
			},
			{
				schemaVersion: 1,
				providers: {
					"openai-codex": {
						lanes: { stored: { slots: { work: { blockedUntil: 4_102_444_800_000, blockReason: "rate_limit" } } } },
					},
				},
			},
		);

		// When: the addon builds its usage/status report.
		const report = await buildUsageReport([], ctx(agentDir));

		// Then: names and health are visible while every token remains absent.
		expect(report).toMatch(/claude-sdk-oauth\s+default\s+login\s+available\s+pinned.*expires\s+2100-01-01T00:00:00\.000Z/);
		expect(report).toMatch(/claude-sdk-oauth\s+login-2\s+login\s+available/);
		expect(report).toMatch(/openai-codex\s+default\s+login\s+available/);
		expect(report).toMatch(/openai-codex\s+work\s+login\s+blocked \(rate_limit\)\s+pinned/);
		expect(report).not.toContain("secret-");
	});

	it("projects a flat Codex OAuth credential as the default slot", async () => {
		// Given: a pre-pool flat OAuth credential.
		const agentDir = sandbox({
			"openai-codex": {
				type: "oauth",
				access: "flat-access",
				refresh: "flat-refresh",
				expires: 4_102_444_800_000,
			},
		});

		// When: status is read without mutating auth.json.
		const report = await buildUsageReport([], ctx(agentDir));

		// Then: stock's compatibility projection is represented as one default account.
		expect(report).toContain("openai-codex  default  login  available");
		expect(report).not.toContain("flat-access");
	});
});


type FakeUsageRequest = (
	input: string,
	init: { readonly headers: Readonly<Record<string, string>>; readonly signal: AbortSignal },
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

function codexToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return "header." + payload + ".signature";
}

const buildWithUsage = buildUsageReport as unknown as (
	packages: readonly never[],
	context: ReturnType<typeof ctx>,
	options: { readonly codexUsageRequest?: FakeUsageRequest; readonly usageRequest?: FakeUsageRequest },
) => Promise<string>;

describe("stock subscription usage", () => {
	it("reports Claude and Codex limits per slot", async () => {
		// Given: one Claude account and two Codex accounts with distinct account ids.
		const agentDir = sandbox({
			"claude-sdk-oauth": {
				type: "oauth",
				access: "claude-sdk-oauth-managed",
				refresh: "claude-sdk-oauth-managed",
				expires: 4_102_444_800_000,
				accounts: [
					{ name: "default", source: "login", access: "claude-access", refresh: "claude-refresh", expires: 4_102_444_800_000 },
				],
			},
			"openai-codex": {
				type: "oauth",
				access: codexToken("acct-default"),
				refresh: "codex-flat-refresh",
				expires: 4_102_444_800_000,
				accounts: [
					{ name: "default", source: "login", access: codexToken("acct-default"), refresh: "codex-default-refresh", expires: 4_102_444_800_000 },
					{ name: "work", source: "login", access: codexToken("acct-work"), refresh: "codex-work-refresh", expires: 4_102_444_800_000 },
				],
			},
		});
		const calledAccounts: string[] = [];
		const request: FakeUsageRequest = async (_input, init) => {
			const accountId = init.headers["ChatGPT-Account-Id"] ?? "";
			calledAccounts.push(accountId);
			const used = accountId === "acct-default" ? [20, 40] : [45, 75];
			return {
				ok: true,
				status: 200,
				json: async () => ({
					rate_limit: {
						primary_window: { used_percent: used[0], limit_window_seconds: 18_000 },
						secondary_window: { used_percent: used[1], limit_window_seconds: 604_800 },
					},
				}),
			};
		};

		// When: usage is built through the injectable HTTP seam.
		const report = await buildWithUsage([], ctx(agentDir), { codexUsageRequest: request });

		// Then: both stock OAuth providers expose bounded usage details.
		expect(calledAccounts).toEqual(["acct-default", "acct-work"]);
		expect(report).toMatch(/claude-sdk-oauth\s+default.*usage unavailable \(HTTP 429\)/);
		expect(report).toMatch(/openai-codex\s+default.*5h 80%.*W 60%/);
		expect(report).toMatch(/openai-codex\s+work.*5h 55%.*W 25%/);
		expect(report).not.toContain("codex-default-refresh");
	});

	it("isolates one Codex usage HTTP failure instead of failing the dashboard", async () => {
		// Given: one valid-looking Codex slot whose usage endpoint rejects the token.
		const agentDir = sandbox({
			"openai-codex": {
				type: "oauth",
				access: codexToken("acct-denied"),
				refresh: "refresh-denied",
				expires: 4_102_444_800_000,
			},
		});
		const request: FakeUsageRequest = async () => ({ ok: false, status: 401, json: async () => ({}) });

		// When: usage is requested.
		const report = await buildWithUsage([], ctx(agentDir), { codexUsageRequest: request });

		// Then: the account remains visible with a bounded, non-secret error.
		expect(report).toMatch(/openai-codex\s+default.*usage unavailable \(HTTP 401\)/);
		expect(report).not.toContain("refresh-denied");
	});

	it("includes live addon plan and reset details", async () => {
		const agentDir = sandbox({
			kiro: {
				type: "oauth",
				accounts: [{ name: "default" }],
			},
		});
		const provider = {
			id: "kiro",
			label: "Kiro",
			build: () => ({}) as never,
			accountUsageDetails: async () => ({
				default: { remaining: 0.72, plan: "KIRO PRO", resetAt: 1_800_000_000_000 },
			}),
		};

		const report = await buildUsageReport([provider], ctx(agentDir));

	expect(report).toContain("72% remaining (KIRO PRO), resets");
	});

	it("fetches Claude SDK OAuth quota instead of reporting it as unsupported", async () => {
		const agentDir = sandbox({
			"claude-sdk-oauth": { type: "oauth", access: "claude-access" },
		});
		const request = vi.fn(async (input: string) => ({
			ok: true,
			status: 200,
			json: async () => ({
				five_hour: { utilization: 25, resets_at: "2026-09-03T15:00:00Z" },
				seven_day: { utilization: 40, resets_at: "2026-09-10T00:00:00Z" },
			}),
			input,
		}));

		const report = await buildUsageReport([], ctx(agentDir), { usageRequest: request });

		expect(report).toContain("claude-sdk-oauth  default  login  available  5h 75% | 7d 60%");
		expect(request).toHaveBeenCalledWith(
			"https://api.anthropic.com/api/oauth/usage",
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: "Bearer claude-access" }),
			}),
		);
	});

	it("fetches Alibaba Token Plan quota for its API-key credential", async () => {
		const agentDir = sandbox({
			"alibaba-token-plan": { type: "api_key", key: "alibaba-key" },
		});
		const request = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				data: {
					DataV2: {
						data: {
							per5HourPercentage: 12,
							per1WeekPercentage: 34,
							per5HourResetTime: 1_800_000_000_000,
							per1WeekResetTime: 1_801_000_000_000,
						},
					},
				},
			}),
		}));

		const report = await buildUsageReport([], ctx(agentDir), { usageRequest: request });

		expect(report).toContain("alibaba-token-plan  default  login  available  5h 88% | W 66%");
		expect(request).toHaveBeenCalledWith(
			"https://bailian-singapore-cs.alibabacloud.com/cli/api.json",
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: "Bearer alibaba-key" }),
			}),
		);
	});

	it("keeps provider usage bounded when quota payloads are malformed", async () => {
		const agentDir = sandbox({
			"claude-sdk-oauth": { type: "oauth", access: "claude-access" },
			"alibaba-token-plan": { type: "api_key", key: "alibaba-key" },
		});
		const request = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));

		const report = await buildUsageReport([], ctx(agentDir), { usageRequest: request });

		expect(report).toMatch(/claude-sdk-oauth\s+default\s+login\s+available\s+usage unavailable \(invalid response\)/);
		expect(report).toMatch(/alibaba-token-plan\s+default\s+login\s+available\s+usage unavailable \(invalid response\)/);
	});
});
