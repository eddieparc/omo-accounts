import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StockAccountProvider } from "./stock-accounts.js";

const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const FIVE_HOURS_SECONDS = 18_000;
const WEEK_SECONDS = 604_800;

type JsonRecord = Readonly<Record<string, unknown>>;

export interface UsageResponse {
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<unknown>;
}

export interface UsageRequestInit {
	readonly headers: Readonly<Record<string, string>>;
	readonly redirect: "error";
	readonly signal: AbortSignal;
}

export type CodexUsageRequest = (input: string, init: UsageRequestInit) => Promise<UsageResponse>;

export interface StockUsageOptions {
	readonly codexUsageRequest?: CodexUsageRequest;
	readonly resolveCodexAccessToken?: (name: string) => Promise<string | undefined>;
	readonly signal?: AbortSignal;
}

interface CredentialSlot {
	readonly name: string;
	readonly access: string | undefined;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): JsonRecord | undefined {
	return isRecord(value) ? value : undefined;
}

function property(value: unknown, key: string): unknown {
	return record(value)?.[key];
}

function stringField(value: JsonRecord, key: string): string | undefined {
	const found = value[key];
	return typeof found === "string" ? found : undefined;
}

function credentialSlots(credential: JsonRecord): CredentialSlot[] {
	const accounts = credential.accounts;
	if (Array.isArray(accounts) && accounts.length > 0) {
		return accounts.flatMap((value) => {
			const slot = record(value);
			const name = slot ? stringField(slot, "name") : undefined;
			return slot && name ? [{ name, access: stringField(slot, "access") }] : [];
		});
	}
	return [{ name: "default", access: stringField(credential, "access") }];
}

function readCredentials(agentDir: string): ReadonlyMap<StockAccountProvider, readonly CredentialSlot[]> {
	const path = join(agentDir, "auth.json");
	if (!existsSync(path)) return new Map();
	const auth = record(JSON.parse(readFileSync(path, "utf8")));
	if (!auth) return new Map();
	const result = new Map<StockAccountProvider, readonly CredentialSlot[]>();
	for (const provider of ["claude-sdk-oauth", "openai-codex"] as const) {
		const credential = record(auth[provider]);
		if (credential && stringField(credential, "type") === "oauth") {
			result.set(provider, credentialSlots(credential));
		}
	}
	return result;
}

function remainingPercent(value: unknown): number | undefined {
	const used = property(value, "used_percent");
	return typeof used === "number" && Number.isFinite(used)
		? Math.round(100 - Math.max(0, Math.min(100, used)))
		: undefined;
}

export interface CodexUsage {
	readonly fiveHourRemainingPercent: number | undefined;
	readonly weeklyRemainingPercent: number | undefined;
}

export function parseCodexUsage(value: unknown): CodexUsage | null {
	const rateLimit = property(value, "rate_limit");
	if (!record(rateLimit)) return null;
	let fiveHourRemainingPercent: number | undefined;
	let weeklyRemainingPercent: number | undefined;
	for (const window of [property(rateLimit, "primary_window"), property(rateLimit, "secondary_window")]) {
		const duration = property(window, "limit_window_seconds");
		const remaining = remainingPercent(window);
		if (remaining === undefined) continue;
		if (duration === FIVE_HOURS_SECONDS) fiveHourRemainingPercent = remaining;
		if (duration === WEEK_SECONDS) weeklyRemainingPercent = remaining;
	}
	return { fiveHourRemainingPercent, weeklyRemainingPercent };
}

export function extractCodexAccountId(token: string): string | undefined {
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		const auth = record(record(decoded)?.["https://api.openai.com/auth"]);
		return auth ? stringField(auth, "chatgpt_account_id") : undefined;
	} catch {
		return undefined;
	}
}

function formatPercent(value: number | undefined): string {
	return value === undefined ? "unavailable" : value + "%";
}

async function codexUsageDetail(access: string, request: CodexUsageRequest, signal?: AbortSignal): Promise<string> {
	const accountId = extractCodexAccountId(access);
	if (!accountId) return "usage unavailable (account id missing)";
	const timeout = AbortSignal.timeout(10_000);
	const response = await request(CODEX_USAGE_ENDPOINT, {
		headers: { Authorization: "Bearer " + access, "ChatGPT-Account-Id": accountId },
		redirect: "error",
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) return "usage unavailable (HTTP " + response.status + ")";
	const usage = parseCodexUsage(await response.json());
	if (!usage) return "usage unavailable (invalid response)";
	return "5h " + formatPercent(usage.fiveHourRemainingPercent) + " | W " + formatPercent(usage.weeklyRemainingPercent);
}

export function stockUsageKey(provider: StockAccountProvider, name: string): string {
	return provider + "\0" + name;
}

export async function readStockUsage(agentDir: string, options: StockUsageOptions = {}): Promise<ReadonlyMap<string, string>> {
	const result = new Map<string, string>();
	const credentials = readCredentials(agentDir);
	for (const slot of credentials.get("claude-sdk-oauth") ?? []) {
		result.set(stockUsageKey("claude-sdk-oauth", slot.name), "quota unavailable (no supported endpoint)");
	}
	const request = options.codexUsageRequest ?? ((input, init) => fetch(input, init));
	await Promise.all((credentials.get("openai-codex") ?? []).map(async (slot) => {
		const storedAccess = slot.access;
		const access = options.resolveCodexAccessToken ? await options.resolveCodexAccessToken(slot.name) : storedAccess;
		let detail = "usage unavailable (credential missing)";
		if (access) {
			try {
				detail = await codexUsageDetail(access, request, options.signal);
			} catch {
				detail = "usage unavailable";
			}
		}
		result.set(stockUsageKey("openai-codex", slot.name), detail);
	}));
	return result;
}
