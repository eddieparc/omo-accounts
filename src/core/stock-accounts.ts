import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
type StockCredentialSlot = {
	readonly name: string;
	readonly source?: "login" | "import" | "env";
	readonly key?: string;
	readonly access?: string;
	readonly refresh?: string;
	readonly expires?: number;
};

type StockPooledCredential = {
	readonly type: "api_key" | "oauth";
	readonly key?: string;
	readonly access?: string;
	readonly refresh?: string;
	readonly expires?: number;
	readonly accounts?: readonly StockCredentialSlot[];
	readonly pinned?: string;
};

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
	if (!Array.isArray(accounts) || accounts.length === 0) return [credential];
	const slots: JsonRecord[] = [];
	for (const value of accounts) {
		const slot = record(value);
		if (slot) slots.push(slot);
	}
	return slots;
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

export function formatStockAccountStatus(
	statuses: readonly StockAccountStatus[],
	usage: ReadonlyMap<string, string> = new Map(),
): string[] {
	if (statuses.length === 0) return [];
	const width = Math.max(...statuses.map((status) => status.provider.length));
	return statuses.map((status) => {
		const state = status.blockReason ? "blocked (" + status.blockReason + ")" : status.state;
		const marks = [status.provider.padEnd(width), status.name, status.source, state];
		if (status.pinned) marks.push("pinned");
		const usageDetail = usage.get(status.provider + "\0" + status.name);
		if (usageDetail) marks.push(usageDetail);
		if (status.expiresAt !== undefined) marks.push("expires", new Date(status.expiresAt).toISOString());
		return marks.join("  ");
	});
}


export interface StockCredentialStore {
	read(provider: string): Promise<unknown>;
	modify(
		provider: string,
		update: (current: unknown) => Promise<unknown>,
	): Promise<unknown>;
}

const STOCK_ACCOUNT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function isStockAccountProvider(provider: string): provider is StockAccountProvider {
	return provider === "claude-sdk-oauth" || provider === "openai-codex";
}

export function assertStockAccountName(name: string): void {
	if (!STOCK_ACCOUNT_NAME.test(name)) {
		throw new Error("Invalid account name '" + name + "': use letters, digits, '-' or '_'");
	}
}

function flatSlot(credential: StockPooledCredential): StockCredentialSlot {
	if (credential.type === "oauth") {
		return {
			name: "default",
			source: "login",
			access: credential.access,
			refresh: credential.refresh,
			expires: credential.expires,
		};
	}
	return { name: "default", source: "login", key: credential.key };
}

function credentialSlots(credential: StockPooledCredential): StockCredentialSlot[] {
	return credential.accounts && credential.accounts.length > 0
		? [...credential.accounts]
		: [flatSlot(credential)];
}

function renamedCredential(current: unknown, from: string, to: string): StockPooledCredential {
	const parsed = record(current);
	if (!parsed) throw new Error("No stored credential for provider");
	const type = stringField(parsed, "type");
	if (type !== "oauth" && type !== "api_key") throw new Error("Unsupported stored credential type");
	const currentAccounts = Array.isArray(parsed.accounts)
		? parsed.accounts.flatMap((value) => {
			const slot = record(value);
			const name = slot ? stringField(slot, "name") : undefined;
			return slot && name ? [{ ...slot, name }] : [];
		})
		: undefined;
	const currentCredential: StockPooledCredential = {
		...parsed,
		type,
		...(currentAccounts ? { accounts: currentAccounts } : {}),
	};
	const credential = currentCredential;
	const accounts = credentialSlots(credential);
	if (accounts.some((account) => account.name === to)) {
		throw new Error("Account '" + to + "' already exists");
	}
	const index = accounts.findIndex((account) => account.name === from);
	if (index < 0) throw new Error("Account '" + from + "' does not exist");
	const target = accounts[index];
	if (!target) throw new Error("Account '" + from + "' does not exist");
	if (target.source === "env") throw new Error("Environment account '" + from + "' cannot be renamed");
	accounts[index] = { ...target, name: to };
	return {
		...credential,
		accounts,
		...(credential.pinned === from ? { pinned: to } : {}),
	};
}

export async function renameStockAccount(
	store: StockCredentialStore,
	provider: string,
	from: string,
	to: string,
): Promise<void> {
	if (!isStockAccountProvider(provider)) throw new Error("Unsupported stock account provider: " + provider);
	assertStockAccountName(from);
	assertStockAccountName(to);
	await store.modify(provider, async (current) => renamedCredential(current, from, to));
}
