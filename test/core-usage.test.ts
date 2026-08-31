import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
		expect(report).toMatch(/claude-sdk-oauth\s+default\s+login\s+available\s+pinned\s+expires\s+2100-01-01T00:00:00\.000Z/);
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
