import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderBuildContext, ProviderConfig, ProviderPackage } from "../../core/types.js";
import { resolveTokenRouterModels, TOKENROUTER_MODELS } from "./models.js";

export const TOKENROUTER_PROVIDER_ID = "tokenrouter";
export const TOKENROUTER_BASE_URL = "https://api.tokenrouter.com/v1";

export { TOKENROUTER_MODELS, resolveTokenRouterModels, type TokenRouterModel } from "./models.js";

function storedKey(agentDir: string): string | undefined {
	const authPath = join(agentDir, "auth.json");
	if (!existsSync(authPath)) return undefined;
	try {
		const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { key?: string }>;
		return auth[TOKENROUTER_PROVIDER_ID]?.key;
	} catch {
		return undefined;
	}
}

function resolveKey(context: ProviderBuildContext): string | undefined {
	return context.env.TOKENROUTER_API_KEY?.trim() || storedKey(context.agentDir);
}

export function tokenrouterProviderPackage(): ProviderPackage {
	return {
		id: TOKENROUTER_PROVIDER_ID,
		label: "TokenRouter",
		enabled(_env, context?: ProviderBuildContext) {
			if (!context) return true;
			return resolveKey(context)
				? true
				: "no TokenRouter credential; run `/login tokenrouter` or set TOKENROUTER_API_KEY";
		},
		build(context: ProviderBuildContext): ProviderConfig {
			const apiKey = resolveKey(context);
			return {
				name: "TokenRouter",
				baseUrl: TOKENROUTER_BASE_URL,
				api: "openai-completions",
				models: resolveTokenRouterModels(context.env),
				...(apiKey === undefined ? {} : { apiKey }),
				oauth: {
					name: "TokenRouter (API key)",
					login: async (callbacks) => {
						const prompt = (callbacks as unknown as { prompt?: (spec: unknown) => Promise<string> }).prompt;
						if (!prompt) throw new Error("TokenRouter login needs an interactive prompt");
						const key = (
							await prompt({
								type: "secret",
								message: "TokenRouter API key (https://www.tokenrouter.com -> Console -> API Keys)",
							})
						).trim();
						if (!key) throw new Error("No TokenRouter API key entered");
						return { type: "api_key", key } as never;
					},
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => (credentials as unknown as { key?: string }).key ?? "",
				},
			};
		},
	};
}
