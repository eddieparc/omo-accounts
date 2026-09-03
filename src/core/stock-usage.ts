import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StockAccountProvider } from "./stock-accounts.js";

const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const CLAUDE_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const GROK_USAGE_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const ALIBABA_USAGE_ENDPOINT = "https://bailian-singapore-cs.alibabacloud.com/cli/api.json";
const ALIBABA_USAGE_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
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
	readonly method?: "POST";
	readonly body?: string;
}

export type CodexUsageRequest = (input: string, init: UsageRequestInit) => Promise<UsageResponse>;
export type UsageRequest = (input: string, init: UsageRequestInit) => Promise<UsageResponse>;

export interface StockUsageOptions {
	readonly codexUsageRequest?: CodexUsageRequest;
	readonly usageRequest?: UsageRequest;
	readonly resolveCodexAccessToken?: (name: string) => Promise<string | undefined>;
	/** Optional Alibaba console bearer token; API keys cannot authenticate console quota calls. */
	readonly alibabaUsageToken?: string;
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

type CredentialKind = "oauth" | "api_key";

interface StoredCredentialSlot extends CredentialSlot {
	readonly key: string | undefined;
	readonly kind: CredentialKind;
}

function readCredentials(agentDir: string): ReadonlyMap<StockAccountProvider, readonly StoredCredentialSlot[]> {
	const path = join(agentDir, "auth.json");
	if (!existsSync(path)) return new Map();
	const auth = record(JSON.parse(readFileSync(path, "utf8")));
	if (!auth) return new Map();
	const result = new Map<StockAccountProvider, readonly StoredCredentialSlot[]>();
	for (const provider of ["xai", "claude-sdk-oauth", "openai-codex", "alibaba-token-plan"] as const) {
		const credential = record(auth[provider]);
		const kind = stringField(credential ?? {}, "type");
		if (!credential || (kind !== "oauth" && kind !== "api_key")) continue;
		const slots: StoredCredentialSlot[] = credentialSlots(credential).map((slot) => ({
			...slot,
			key: slot.access ?? stringField(credential, "key"),
			kind: kind as CredentialKind,
		}));
		result.set(provider, slots);
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

function usageNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function unwrapUsage(value: unknown): JsonRecord | undefined {
	let current = record(value);
	for (let index = 0; current && index < 3; index++) {
		const nested = record(property(record(property(current, "data")), "DataV2"));
		if (!nested) return current;
		current = record(property(nested, "data")) ?? nested;
	}
	return current;
}

interface ClaudeUsage {
	readonly fiveHourRemainingPercent: number | undefined;
	readonly weeklyRemainingPercent: number | undefined;
}

function parseClaudeUsage(value: unknown): ClaudeUsage | null {
	const body = record(value);
	if (!body) return null;
	const window = (key: string): number | undefined => {
		const utilization = usageNumber(property(body, key) && property(property(body, key), "utilization"));
		return utilization === undefined ? undefined : Math.round(100 - Math.max(0, Math.min(100, utilization)));
	};
	const fiveHourRemainingPercent = window("five_hour");
	const weeklyRemainingPercent = window("seven_day");
	return fiveHourRemainingPercent === undefined && weeklyRemainingPercent === undefined
		? null
		: { fiveHourRemainingPercent, weeklyRemainingPercent };
}

function parseGrokUsage(value: unknown): number | undefined {
	const body = record(value);
	const config = record(property(body, "config"));
	const used = usageNumber(property(config, "creditUsagePercent"));
	return used === undefined ? undefined : Math.round(100 - Math.max(0, Math.min(100, used)));
}

interface AlibabaUsage {
	readonly fiveHourRemainingPercent: number | undefined;
	readonly weeklyRemainingPercent: number | undefined;
}

function parseAlibabaUsage(value: unknown): AlibabaUsage | null {
	const body = unwrapUsage(value);
	if (!body) return null;
	const fiveHour = usageNumber(body.per5HourPercentage);
	const weekly = usageNumber(body.per1WeekPercentage);
	return fiveHour === undefined && weekly === undefined
		? null
		: {
				fiveHourRemainingPercent: fiveHour === undefined ? undefined : Math.round(100 - Math.max(0, Math.min(100, fiveHour))),
				weeklyRemainingPercent: weekly === undefined ? undefined : Math.round(100 - Math.max(0, Math.min(100, weekly))),
			};
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

async function oauthUsageDetail(
	access: string,
	request: UsageRequest,
	signal?: AbortSignal,
): Promise<string> {
	const response = await request(CLAUDE_USAGE_ENDPOINT, {
		headers: {
			Authorization: "Bearer " + access,
			"anthropic-beta": "oauth-2025-04-20",
			"User-Agent": "claude-code",
		},
		redirect: "error",
		signal: signal ?? AbortSignal.timeout(10_000),
	});
	if (!response.ok) return "usage unavailable (HTTP " + response.status + ")";
	const usage = parseClaudeUsage(await response.json());
	if (!usage) return "usage unavailable (invalid response)";
	return "5h " + formatPercent(usage.fiveHourRemainingPercent) + " | 7d " + formatPercent(usage.weeklyRemainingPercent);
}

function grokUserId(access: string): string | undefined {
	const payload = access.split(".")[1];
	if (!payload) return undefined;
	try {
		const claims = record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
		return stringField(claims ?? {}, "principal_id") ?? stringField(claims ?? {}, "sub");
	} catch {
		return undefined;
	}
}

async function grokUsageDetail(
	access: string,
	request: UsageRequest,
	signal?: AbortSignal,
): Promise<string> {
	const userId = grokUserId(access);
	if (!userId) return "usage unavailable (user id missing)";
	const response = await request(GROK_USAGE_ENDPOINT, {
		headers: {
			Authorization: "Bearer " + access,
			"X-XAI-Token-Auth": "xai-grok-cli",
			"x-userid": userId,
			"x-grok-client-mode": "headless",
		},
		redirect: "error",
		signal: signal ?? AbortSignal.timeout(10_000),
	});
	if (!response.ok) return "usage unavailable (HTTP " + response.status + ")";
	const remaining = parseGrokUsage(await response.json());
	return remaining === undefined
		? "usage unavailable (invalid response)"
		: "credits " + formatPercent(remaining) + " remaining";
}

async function alibabaUsageDetail(
	key: string,
	request: UsageRequest,
	signal?: AbortSignal,
): Promise<string> {
	const params = JSON.stringify({
		Api: ALIBABA_USAGE_API,
		V: "1.0",
		Data: {
			cornerstoneParam: {
				protocol: "V2",
				console: "ONE_CONSOLE",
				productCode: "p_efm",
				switchUserType: 3,
				consoleSite: "BAILIAN_ALIYUN",
			},
		},
	});
	const response = await request(ALIBABA_USAGE_ENDPOINT, {
		headers: {
			Accept: "*/*",
			Authorization: "Bearer " + key,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		redirect: "error",
		signal: signal ?? AbortSignal.timeout(10_000),
		method: "POST",
		body: new URLSearchParams({ params, region: "ap-southeast-1" }).toString(),
	});
	if (!response.ok) return "usage unavailable (HTTP " + response.status + ")";
	const usage = parseAlibabaUsage(await response.json());
	if (!usage) return "usage unavailable (invalid response)";
	return "5h " + formatPercent(usage.fiveHourRemainingPercent) + " | W " + formatPercent(usage.weeklyRemainingPercent);
}

export function stockUsageKey(provider: StockAccountProvider, name: string): string {
	return provider + "\0" + name;
}

export async function readStockUsage(agentDir: string, options: StockUsageOptions = {}): Promise<ReadonlyMap<string, string>> {
	const result = new Map<string, string>();
	const credentials = readCredentials(agentDir);
	const request = options.usageRequest ?? ((input, init) => fetch(input, init));
	await Promise.all((credentials.get("xai") ?? []).map(async (slot) => {
		let detail = "usage unavailable (credential missing)";
		if (slot.access) {
			try {
				detail = await grokUsageDetail(slot.access, request, options.signal);
			} catch {
				detail = "usage unavailable";
			}
		}
		result.set(stockUsageKey("xai", slot.name), detail);
	}));
	await Promise.all((credentials.get("claude-sdk-oauth") ?? []).map(async (slot) => {
		let detail = "usage unavailable (credential missing)";
		if (slot.access) {
			try {
				detail = await oauthUsageDetail(slot.access, request, options.signal);
			} catch {
				detail = "usage unavailable";
			}
		}
		result.set(stockUsageKey("claude-sdk-oauth", slot.name), detail);
	}));
	await Promise.all((credentials.get("alibaba-token-plan") ?? []).map(async (slot) => {
		let detail = "usage unavailable (credential missing)";
		const usageToken = options.alibabaUsageToken ?? process.env.ALIBABA_TOKEN_PLAN_CONSOLE_TOKEN ?? slot.key;
		if (usageToken) {
			try {
				detail = await alibabaUsageDetail(usageToken, request, options.signal);
			} catch {
				detail = "usage unavailable";
			}
		}
		result.set(stockUsageKey("alibaba-token-plan", slot.name), detail);
	}));
	const codexRequest = options.codexUsageRequest ?? ((input, init) => fetch(input, init));
	await Promise.all((credentials.get("openai-codex") ?? []).map(async (slot) => {
		const storedAccess = slot.access;
		const access = options.resolveCodexAccessToken ? await options.resolveCodexAccessToken(slot.name) : storedAccess;
		let detail = "usage unavailable (credential missing)";
		if (access) {
			try {
				detail = await codexUsageDetail(access, codexRequest, options.signal);
			} catch {
				detail = "usage unavailable";
			}
		}
		result.set(stockUsageKey("openai-codex", slot.name), detail);
	}));
	return result;
}
