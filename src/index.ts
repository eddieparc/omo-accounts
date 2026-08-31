import { homedir } from "node:os";
import { join } from "node:path";
import { EXTENSION_ID, registerProviderPackages } from "./core/registry.js";
import type {
	ExtensionCommandContext,
	ProviderBuildContext,
	ProviderHealth,
	ProviderPackage,
	SenpiExtensionAPI,
} from "./core/types.js";
import { migrationSink } from "./core/migration-sink.js";
import { runStockAccountCommand, stockAccountInteraction } from "./core/stock-account-command.js";
import { buildUsageReport } from "./core/usage.js";

export type { ProviderPackage, ProviderHealth, ProviderBuildContext } from "./core/types.js";
export { EXTENSION_ID } from "./core/registry.js";

/** omo-accounts — Kiro account routing plus OpenGateway and TokenRouter for OMO. */

export function resolveAgentDir(env: NodeJS.ProcessEnv): string {
	const configured = env.OMO_CODING_AGENT_DIR?.trim() ?? env.SENPI_CODING_AGENT_DIR?.trim();
	if (configured) {
		return configured.startsWith("~") ? join(homedir(), configured.slice(1)) : configured;
	}
	return join(homedir(), ".omo", "agent");
}

async function loadProviderPackages(): Promise<{ packages: ProviderPackage[]; failures: ProviderHealth[] }> {
	const packages: ProviderPackage[] = [];
	const failures: ProviderHealth[] = [];

	const loaders: { id: string; load: () => Promise<ProviderPackage> }[] = [
		{ id: "kiro", load: async () => (await import("./providers/kiro/index.js")).kiroProviderPackage() },
		{
			id: "opengateway",
			load: async () => (await import("./providers/opengateway/index.js")).opengatewayProviderPackage(),
		},
		{
			id: "tokenrouter",
			load: async () => (await import("./providers/tokenrouter/index.js")).tokenrouterProviderPackage(),
		},
	];

	for (const loader of loaders) {
		try {
			packages.push(await loader.load());
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			failures.push({ status: "degraded", providerId: loader.id, reason, error });
			console.error(`${EXTENSION_ID}: provider '${loader.id}' failed to load: ${reason}`);
		}
	}

	return { packages, failures };
}

export default async function omoAccounts(pi: SenpiExtensionAPI): Promise<void> {
	const env = process.env;
	const context: ProviderBuildContext = { env, agentDir: resolveAgentDir(env) };

	const { packages, failures } = await loadProviderPackages();
	const { health } = await registerProviderPackages(pi, packages, context);
	const allHealth = [...failures, ...health];
	const registered = packages.filter((entry) =>
		allHealth.some((item) => item.providerId === entry.id && item.status === "registered"),
	);

	// A provider stream has no ExtensionContext of its own, so the newest session
	// context is captured here and migration notices are delivered through it.
	pi.on("session_start", (_event, ctx) => {
		migrationSink.attach(ctx);
	});

	pi.registerCommand("usage", {
		description: "Show remaining usage across configured Kiro accounts.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			ctx.ui.notify(await buildUsageReport(registered, context), "info");
		},
	});

	pi.registerCommand("omo-account", {
		description: "Manage stock Claude and OpenAI OAuth accounts.",
		argumentHint: "<claude-sdk-oauth|openai-codex> [list|usage|rename <from> <to>|relogin <name>]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const output = await runStockAccountCommand(
				{
					agentDir: ctx.agentDir,
					store: ctx.modelRegistry.authStorage,
					runtime: ctx.modelRegistry.modelRuntime,
					interaction: stockAccountInteraction(ctx),
				},
				args,
			);
			ctx.ui.notify(output.text, output.level);
		},
	});

	pi.registerCommand("omo-accounts", {
		description: "Show omo-accounts provider health.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const lines = allHealth.map((entry) => {
				if (entry.status === "registered") return `  ${entry.providerId}: registered`;
				if (entry.status === "skipped") return `  ${entry.providerId}: skipped (${entry.reason})`;
				return `  ${entry.providerId}: DEGRADED (${entry.reason})`;
			});
			ctx.ui.notify(
				[`${EXTENSION_ID}:`, ...(lines.length > 0 ? lines : ["  (no providers)"])].join("\n"),
				allHealth.some((entry) => entry.status === "degraded") ? "error" : "info",
			);
		},
	});
}
