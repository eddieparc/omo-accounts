import type { ExtensionAPI } from "@code-yeongyu/senpi";

const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

function token(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return "header." + payload + ".signature";
}

function requestUrl(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	return input instanceof URL ? input.href : input.url;
}

export default function stockAccountSandbox(pi: ExtensionAPI): void {
	const originalFetch = globalThis.fetch;
	const sandboxFetch: typeof fetch = async (input, init) => {
		if (requestUrl(input) !== USAGE_ENDPOINT) return originalFetch(input, init);
		const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
		const used = accountId === "acct-default" ? [20, 40] : [45, 75];
		return new Response(
			JSON.stringify({
				rate_limit: {
					primary_window: { used_percent: used[0], limit_window_seconds: 18_000 },
					secondary_window: { used_percent: used[1], limit_window_seconds: 604_800 },
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
	globalThis.fetch = sandboxFetch;

	pi.registerProvider("openai-codex", {
		oauth: {
			name: "Sandbox OpenAI Codex OAuth",
			login: async () => ({
				type: "oauth",
				access: token("acct-work-new"),
				refresh: "sandbox-new-refresh",
				expires: 4_102_444_800_000,
			}),
			refreshToken: async (credentials) => credentials,
			getApiKey: (credentials) => credentials.access,
		},
	});

	pi.on("session_shutdown", () => {
		globalThis.fetch = originalFetch;
	});
}
