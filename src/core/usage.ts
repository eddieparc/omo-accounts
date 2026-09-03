import { isBlocked } from "./accounts.js";
import { readPool } from "./store.js";
import { formatStockAccountStatus, readStockAccountStatus } from "./stock-accounts.js";
import { readStockUsage, type StockUsageOptions } from "./stock-usage.js";
import type { ProviderBuildContext, ProviderPackage, ProviderUsageDetail } from "./types.js";

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
			let pool: ReturnType<typeof readPool>;
			try {
				pool = readPool(context.agentDir, entry.id);
			} catch {
				return [];
			}
			if (pool.accounts.length === 0) return [];

			let usage: Record<string, number | undefined> = {};
			let details: Record<string, ProviderUsageDetail> = {};
			if (entry.accountUsageDetails) {
				try {
					details = await entry.accountUsageDetails(context);
				} catch {
					details = {};
				}
			}
			if (entry.accountUsage && Object.keys(details).length === 0) {
				try {
					usage = await entry.accountUsage(context);
				} catch {
					usage = {};
				}
			}

			const now = Date.now();
			return pool.accounts.map((slot) => {
				const metadata = details[slot.name];
				const headroom = metadata?.remaining ?? usage[slot.name];
				const state =
					slot.blockReason === "auth_error"
						? "needs re-login"
						: isBlocked(slot, now)
							? `blocked ${Math.ceil(((slot.blockedUntil ?? now) - now) / 1000)}s (${slot.blockReason ?? "unknown"})`
							: "available";
				const plan = metadata?.plan ? ` (${metadata.plan})` : "";
				const resets = metadata?.resetAt ? `, resets ${new Date(metadata.resetAt).toLocaleString()}` : "";
				const left = typeof headroom === "number" ? `${percent(headroom)} remaining${plan}${resets}, ` : "";
				return { provider: entry.id, detail: `${slot.name}: ${left}${state}` };
			});
		}),
	);
	return results.flat();
}

export async function buildUsageReport(
	packages: readonly ProviderPackage[],
	context: ProviderBuildContext,
	options: StockUsageOptions = {},
): Promise<string> {
	const [addon, stockUsage] = await Promise.all([
		addonLines(packages, context),
		readStockUsage(context.agentDir, options),
	]);
	const stock = formatStockAccountStatus(readStockAccountStatus(context.agentDir), stockUsage);
	if (addon.length === 0 && stock.length === 0) {
		return "No managed subscriptions found. Add one with /login <provider>.";
	}

	const width = addon.length > 0 ? Math.max(...addon.map((line) => line.provider.length)) : 0;
	return [
		"Subscription account status:",
		...stock.map((line) => "  " + line),
		...addon.map((line) => "  " + line.provider.padEnd(width) + "  " + line.detail),
	].join("\n");
}
