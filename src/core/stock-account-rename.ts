import type { StockAccountProvider } from "./stock-accounts.js";

type JsonRecord = Readonly<Record<string, unknown>>;

type StockCredentialSlot = JsonRecord & {
	readonly name: string;
	readonly source?: "login" | "import" | "env";
};

type StockPooledCredential = JsonRecord & {
	readonly type: "api_key" | "oauth";
	readonly key?: string;
	readonly access?: string;
	readonly refresh?: string;
	readonly expires?: number;
	readonly accounts?: readonly StockCredentialSlot[];
	readonly pinned?: string;
};

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): JsonRecord | undefined {
	return isRecord(value) ? value : undefined;
}

function stringField(value: JsonRecord, key: string): string | undefined {
	const found = value[key];
	return typeof found === "string" ? found : undefined;
}

export interface StockCredentialStore {
	read(provider: string): Promise<unknown>;
	modify(
		provider: string,
		update: (current: unknown) => Promise<unknown>,
	): Promise<unknown>;
}

const STOCK_ACCOUNT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function isStockAccountProvider(
	provider: string,
): provider is Exclude<StockAccountProvider, "alibaba-token-plan"> {
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

export interface RenameStockAccountOptions {
	readonly store: StockCredentialStore;
	readonly provider: string;
	readonly from: string;
	readonly to: string;
}

export async function renameStockAccount(options: RenameStockAccountOptions): Promise<void> {
	if (!isStockAccountProvider(options.provider)) {
		throw new Error("Unsupported stock account provider: " + options.provider);
	}
	assertStockAccountName(options.from);
	assertStockAccountName(options.to);
	await options.store.modify(options.provider, async (current) =>
		renamedCredential(current, options.from, options.to),
	);
}
