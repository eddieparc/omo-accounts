import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const STOCK_ACCOUNT_PROVIDERS = ["claude-sdk-oauth", "openai-codex"] as const;
export type StockAccountProvider = (typeof STOCK_ACCOUNT_PROVIDERS)[number];

export interface StockAccountStatus {
	readonly provider: StockAccountProvider;
	readonly name: string;
	readonly source: "login" | "import" | "env";
	readonly state: "available" | "blocked";
	readonly blockReason: string | undefined;
	readonly pinned: boolean;
	readonly expiresAt: number | undefined;
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

function numberField(value: JsonRecord, key: string): number | undefined {
	const found = value[key];
	return typeof found === "number" && Number.isFinite(found) ? found : undefined;
}

function readJson(path: string): JsonRecord | undefined {
	if (!existsSync(path)) return undefined;
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	return record(parsed);
}

function storedSlots(credential: JsonRecord): readonly JsonRecord[] {
	const accounts = credential.accounts;
	if (Array.isArray(accounts) && accounts.length > 0) {
		return accounts.flatMap((value) => record(value) ?? []);
	}
	return [credential];
}

function sourceOf(slot: JsonRecord): StockAccountStatus["source"] {
	const source = stringField(slot, "source");
	return source === "import" || source === "env" ? source : "login";
}

function sidecarSlot(root: JsonRecord | undefined, provider: string, name: string): JsonRecord | undefined {
	const providers = record(root?.providers);
	const providerState = record(providers?.[provider]);
	const lanes = record(providerState?.lanes);
	const stored = record(lanes?.stored);
	const slots = record(stored?.slots);
	return record(slots?.[name]);
}

function blockReason(slot: JsonRecord, sidecar: JsonRecord | undefined, now: number): string | undefined {
	const reason = stringField(sidecar ?? {}, "blockReason") ?? stringField(slot, "blockReason");
	if (reason === "auth_error" || reason === "account_disabled") return reason;
	const until = numberField(sidecar ?? {}, "blockedUntil") ?? numberField(slot, "blockedUntil");
	return until !== undefined && until > now ? (reason ?? "unknown") : undefined;
}

export function readStockAccountStatus(agentDir: string, now = Date.now()): StockAccountStatus[] {
	const auth = readJson(join(agentDir, "auth.json"));
	if (!auth) return [];
	const sidecar = readJson(join(agentDir, "credential-pool-state.json"));
	const statuses: StockAccountStatus[] = [];

	for (const provider of STOCK_ACCOUNT_PROVIDERS) {
		const credential = record(auth[provider]);
		if (!credential || stringField(credential, "type") !== "oauth") continue;
		const pinned = stringField(credential, "pinned");
		for (const [index, slot] of storedSlots(credential).entries()) {
			const name = stringField(slot, "name") ?? (index === 0 ? "default" : undefined);
			if (!name) continue;
			const reason = blockReason(slot, sidecarSlot(sidecar, provider, name), now);
			statuses.push({
				provider,
				name,
				source: sourceOf(slot),
				state: reason === undefined ? "available" : "blocked",
				blockReason: reason,
				pinned: pinned === name,
				expiresAt: numberField(slot, "expires") ?? numberField(credential, "expires"),
			});
		}
	}
	return statuses;
}

export function formatStockAccountStatus(statuses: readonly StockAccountStatus[]): string[] {
	if (statuses.length === 0) return [];
	const width = Math.max(...statuses.map((status) => status.provider.length));
	return statuses.map((status) => {
		const state = status.blockReason ? "blocked (" + status.blockReason + ")" : status.state;
		const marks = [status.provider.padEnd(width), status.name, status.source, state];
		if (status.pinned) marks.push("pinned");
		if (status.expiresAt !== undefined) marks.push("expires", new Date(status.expiresAt).toISOString());
		return marks.join("  ");
	});
}
