import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildUsageReport } from "../src/core/usage.js";

const ctx = (agentDir: string) => ({ env: {} as NodeJS.ProcessEnv, agentDir });

describe("usage dashboard", () => {
	it("ignores subscriptions that omo-accounts does not manage", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "omo-accounts-usage-"));
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 1 } }),
		);

		expect(await buildUsageReport([], ctx(agentDir))).toBe(
			"No Kiro subscriptions found. Add one with /login kiro.",
		);
	});
});
