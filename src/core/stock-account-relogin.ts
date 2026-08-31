import { assertStockAccountName, isStockAccountProvider } from "./stock-accounts.js";

type JsonRecord = Readonly<Record<string, unknown>>;

interface Slot extends JsonRecord {
	readonly name: string;
	readonly source?: "login" | "import" | "env";
}

interface ParsedCredential {
	readonly raw: JsonRecord;
	readonly accounts: readonly Slot[];
	readonly hadAccounts: boolean;
}

interface OAuthMaterial {
	readonly access: string;
	readonly refresh: string;
	readonly expires: number;
}

export interface ReloginCredentialStore {
	read(provider: string): Promise<unknown>;
	modify(provider: string, update: (current: unknown) => Promise<unknown>): Promise<unknown>;
}

export interface ReloginInteraction {
	readonly signal?: AbortSignal;
	readonly prompt: (spec: unknown) => Promise<string>;
	readonly notify: (event: unknown) => void;
}

export interface ReloginRuntime {
	login(provider: string, type: "oauth", interaction: ReloginInteraction): Promise<unknown>;
}

export interface ReloginStockAccountOptions {
	readonly store: ReloginCredentialStore;
	readonly runtime: ReloginRuntime;
	readonly provider: string;
	readonly name: string;
	readonly interaction: ReloginInteraction;
}

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

function slot(value: unknown): Slot | undefined {
	const parsed = record(value);
	const name = parsed ? stringField(parsed, "name") : undefined;
	return parsed && name ? { ...parsed, name } : undefined;
}

function flatSlot(credential: JsonRecord): Slot {
	return {
		name: "default",
		source: "login",
		access: stringField(credential, "access"),
		refresh: stringField(credential, "refresh"),
		expires: numberField(credential, "expires"),
	};
}

function parseCredential(value: unknown): ParsedCredential {
	const raw = record(value);
	if (!raw || stringField(raw, "type") !== "oauth") {
		throw new Error("Stock account re-login requires a stored OAuth credential");
	}
	const values = raw.accounts;
	if (!Array.isArray(values) || values.length === 0) {
		return { raw, accounts: [flatSlot(raw)], hadAccounts: false };
	}
	const accounts: Slot[] = [];
	for (const value of values) {
		const parsed = slot(value);
		if (parsed) accounts.push(parsed);
	}
	return { raw, accounts, hadAccounts: true };
}

function oauthMaterial(value: unknown): OAuthMaterial {
	const credential = parseCredential(value);
	const candidate = credential.hadAccounts ? credential.accounts.at(-1) : credential.raw;
	if (!candidate) throw new Error("OAuth login returned no credential material");
	const access = stringField(candidate, "access");
	const refresh = stringField(candidate, "refresh");
	const expires = numberField(candidate, "expires");
	if (!access || !refresh || expires === undefined) {
		throw new Error("OAuth login returned incomplete credential material");
	}
	return { access, refresh, expires };
}

function sameMaterial(value: Slot, material: OAuthMaterial): boolean {
	return stringField(value, "access") === material.access || stringField(value, "refresh") === material.refresh;
}

function reconcileCredential(
	baseline: ParsedCredential,
	currentValue: unknown,
	name: string,
	material: OAuthMaterial,
): JsonRecord {
	if (!baseline.hadAccounts) return { ...baseline.raw, ...material };
	const current = parseCredential(currentValue);
	const baselineNames = new Set(baseline.accounts.map((account) => account.name));
	const currentByName = new Map(current.accounts.map((account) => [account.name, account]));
	const accounts = baseline.accounts.map((account) => {
		if (account.name === name) return { ...account, ...material, source: "login" as const };
		return currentByName.get(account.name) ?? account;
	});
	for (const account of current.accounts) {
		if (!baselineNames.has(account.name) && !sameMaterial(account, material)) accounts.push(account);
	}
	return { ...baseline.raw, accounts };
}

export async function reloginStockAccount(options: ReloginStockAccountOptions): Promise<void> {
	if (!isStockAccountProvider(options.provider)) {
		throw new Error("Unsupported stock account provider: " + options.provider);
	}
	assertStockAccountName(options.name);
	const baseline = parseCredential(await options.store.read(options.provider));
	const target = baseline.accounts.find((account) => account.name === options.name);
	if (!target) throw new Error("Account '" + options.name + "' does not exist");
	if (target.source === "env") throw new Error("Environment account '" + options.name + "' cannot be re-logged in");

	const loggedIn = await options.runtime.login(options.provider, "oauth", options.interaction);
	const material = oauthMaterial(loggedIn);
	await options.store.modify(options.provider, async (current) =>
		reconcileCredential(baseline, current, options.name, material),
	);
}
