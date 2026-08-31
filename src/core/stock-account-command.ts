import type { ExtensionCommandContext } from "@code-yeongyu/senpi";
import {
	formatStockAccountStatus,
	isStockAccountProvider,
	readStockAccountStatus,
	renameStockAccount,
	type StockCredentialStore,
} from "./stock-accounts.js";
import { reloginStockAccount, type ReloginInteraction, type ReloginRuntime } from "./stock-account-relogin.js";
import { readStockUsage, type CodexUsageRequest } from "./stock-usage.js";

export interface StockAccountCommandRuntime extends ReloginRuntime {
	getAuth?(provider: string, options: { readonly slotName: string }): Promise<unknown>;
}

export interface StockAccountCommandDeps {
	readonly agentDir: string;
	readonly store: StockCredentialStore;
	readonly runtime: StockAccountCommandRuntime;
	readonly interaction?: ReloginInteraction;
	readonly codexUsageRequest?: CodexUsageRequest;
}

export interface StockAccountCommandOutput {
	readonly text: string;
	readonly level: "info" | "error";
}

type JsonRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): JsonRecord | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;
}

function stringField(value: JsonRecord, key: string): string | undefined {
	const found = value[key];
	return typeof found === "string" ? found : undefined;
}

function usage(): StockAccountCommandOutput {
	return {
		text: "Usage: /omo-account <claude-sdk-oauth|openai-codex> [list|usage|rename <from> <to>|relogin <name>]",
		level: "error",
	};
}

export function stockAccountInteraction(ctx: ExtensionCommandContext): ReloginInteraction {
	return {
		signal: ctx.signal,
		prompt: async (spec) => {
			const value = record(spec);
			const message = value ? stringField(value, "message") : undefined;
			const answer = await ctx.ui.input(message ?? "OAuth input");
			if (answer === undefined) throw new Error("Login cancelled");
			return answer;
		},
		notify: (event) => {
			const value = record(event);
			const message = value ? stringField(value, "message") ?? stringField(value, "url") : undefined;
			ctx.ui.notify(message ?? "OAuth authentication update.", "info");
		},
	};
}

function defaultInteraction(): ReloginInteraction {
	return {
		prompt: async () => "",
		notify: () => undefined,
	};
}

async function resolvedCodexToken(runtime: StockAccountCommandRuntime, name: string): Promise<string | undefined> {
	if (!runtime.getAuth) return undefined;
	const result = record(await runtime.getAuth("openai-codex", { slotName: name }));
	const auth = record(result?.auth);
	return auth ? stringField(auth, "apiKey") : undefined;
}

async function listOutput(deps: StockAccountCommandDeps, provider: "claude-sdk-oauth" | "openai-codex", withUsage: boolean): Promise<StockAccountCommandOutput> {
	const statuses = readStockAccountStatus(deps.agentDir).filter((status) => status.provider === provider);
	if (statuses.length === 0) return { text: "No stored accounts for " + provider + ".", level: "info" };
	const usageDetails = withUsage
		? await readStockUsage(deps.agentDir, {
			codexUsageRequest: deps.codexUsageRequest,
			resolveCodexAccessToken: provider === "openai-codex"
				? (name) => resolvedCodexToken(deps.runtime, name)
				: undefined,
		})
		: new Map<string, string>();
	return {
		text: formatStockAccountStatus(statuses, usageDetails).join("\n"),
		level: "info",
	};
}

export async function runStockAccountCommand(
	deps: StockAccountCommandDeps,
	rawArgs: string,
): Promise<StockAccountCommandOutput> {
	const args = rawArgs.trim().split(/\s+/).filter(Boolean);
	const provider = args[0];
	if (!provider || !isStockAccountProvider(provider)) return usage();
	const action = args[1] ?? "list";
	try {
		switch (action) {
			case "list":
				return listOutput(deps, provider, false);
			case "usage":
				return listOutput(deps, provider, true);
			case "rename": {
				const from = args[2];
				const to = args[3];
				if (!from || !to) return usage();
				await renameStockAccount(deps.store, provider, from, to);
				return { text: "Renamed " + provider + " account '" + from + "' to '" + to + "'.", level: "info" };
			}
			case "relogin": {
				const name = args[2];
				if (!name) return usage();
				await reloginStockAccount({
					store: deps.store,
					runtime: deps.runtime,
					provider,
					name,
					interaction: deps.interaction ?? defaultInteraction(),
				});
				return { text: "Re-logged in " + provider + " account '" + name + "'.", level: "info" };
			}
			default:
				return usage();
		}
	} catch (error) {
		return { text: error instanceof Error ? error.message : String(error), level: "error" };
	}
}
