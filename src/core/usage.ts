import { isBlocked } from "./accounts.js";
import { readPool } from "./store.js";
import type { ProviderBuildContext, ProviderPackage } from "./types.js";

/** Usage dashboard for the Kiro accounts managed by this addon. */

export interface ProviderUsageLine {
	provider: string;
	detail: string;
}

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

/** Per-account headroom for Kiro accounts. */
async function addonLines(
	packages: readonly ProviderPackage[],
	context: ProviderBuildContext,
): Promise<ProviderUsageLine[]> {
	const results = await Promise.all(
		packages.map(async (entry): Promise<ProviderUsageLine[]> => {
			const pool = readPool(context.agentDir, entry.id);
			if (pool.accounts.length === 0) return [];

			let usage: Record<string, number | undefined> = {};
			if (entry.accountUsage) {
				try {
					usage = await entry.accountUsage(context);
				} catch {
					usage = {};
				}
			}

			const now = Date.now();
			return pool.accounts.map((slot) => {
				const headroom = usage[slot.name];
				const state =
					slot.blockReason === "auth_error"
						? "needs re-login"
						: isBlocked(slot, now)
							? `blocked ${Math.ceil(((slot.blockedUntil ?? now) - now) / 1000)}s (${slot.blockReason ?? "unknown"})`
							: "available";
				const left = typeof headroom === "number" ? `${percent(headroom)} remaining, ` : "";
				return { provider: entry.id, detail: `${slot.name}: ${left}${state}` };
			});
		}),
	);
	return results.flat();
}

export async function buildUsageReport(
	packages: readonly ProviderPackage[],
	context: ProviderBuildContext,
): Promise<string> {
	const lines = await addonLines(packages, context);
	if (lines.length === 0) return "No Kiro subscriptions found. Add one with /login kiro.";

	const width = Math.max(...lines.map((line) => line.provider.length));
	return ["Kiro usage:", ...lines.map((line) => `  ${line.provider.padEnd(width)}  ${line.detail}`)].join("\n");
}
