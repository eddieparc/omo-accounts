import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentDir } from "../src/index.js";
import { SENTINEL } from "../src/core/store.js";

const TARGET_SENPI_VERSION = "2026.8.24";

describe("omo-accounts migration contract", () => {
	it("keeps the published npm identity while targeting the embedded Senpi engine", () => {
		const manifest = JSON.parse(
			readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
		) as {
			name?: string;
			devDependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
		};

		expect(manifest.name).toBe("@eddieparc/senpi-accounts");
		expect(manifest.devDependencies?.["@code-yeongyu/senpi"]).toBe(TARGET_SENPI_VERSION);
		expect(manifest.peerDependencies?.["@code-yeongyu/senpi"]).toBe(`>=${TARGET_SENPI_VERSION}`);
	});

	it("prefers the OMO agent directory and keeps Senpi as a legacy override", () => {
		expect(
			resolveAgentDir({
				OMO_CODING_AGENT_DIR: "/tmp/omo-agent",
				SENPI_CODING_AGENT_DIR: "/tmp/senpi-agent",
			} as NodeJS.ProcessEnv),
		).toBe("/tmp/omo-agent");
		expect(
			resolveAgentDir({
				SENPI_CODING_AGENT_DIR: "/tmp/senpi-agent",
			} as NodeJS.ProcessEnv),
		).toBe("/tmp/senpi-agent");
		expect(resolveAgentDir({} as NodeJS.ProcessEnv)).toBe(join(homedir(), ".omo", "agent"));
	});

	it("keeps the shipped sentinel for existing managed credentials", () => {
		expect(SENTINEL.access).toBe("senpi-accounts-managed");
		expect(SENTINEL.refresh).toBe("senpi-accounts-managed");
	});
});
