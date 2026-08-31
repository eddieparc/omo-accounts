export interface TokenRouterModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat: {
		supportsStore: boolean;
		supportsDeveloperRole: boolean;
		supportsReasoningEffort: boolean;
		supportsUsageInStreaming: boolean;
		supportsStrictMode: boolean;
		maxTokensField: "max_tokens";
	};
}

const COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsStrictMode: false,
	maxTokensField: "max_tokens",
} as const;

export const TOKENROUTER_MODELS: TokenRouterModel[] = [
	{
		id: "moonshotai/kimi-k3-free",
		name: "Kimi K3 (free)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 262_144,
		compat: COMPAT,
	},
	{
		id: "moonshotai/kimi-k3",
		name: "Kimi K3",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.6, output: 2.5, cacheRead: 0.06, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 262_144,
		compat: COMPAT,
	},
	{
		id: "deepseek/deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		compat: COMPAT,
	},
	{
		id: "qwen/qwen3.7-max",
		name: "Qwen 3.7 Max",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.2, output: 6, cacheRead: 0.24, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 65_536,
		compat: COMPAT,
	},
	{
		id: "z-ai/glm-5.2",
		name: "GLM 5.2",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		compat: COMPAT,
	},
];

export function resolveTokenRouterModels(env: NodeJS.ProcessEnv): TokenRouterModel[] {
	const override = env.TOKENROUTER_MODELS_OVERRIDE?.trim();
	if (!override) return TOKENROUTER_MODELS;

	const known = new Map(TOKENROUTER_MODELS.map((model) => [model.id, model]));
	return override
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean)
		.map(
			(id) =>
				known.get(id) ?? {
					id,
					name: id,
					reasoning: false,
					input: ["text" as const],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 32_000,
					compat: COMPAT,
				},
		);
}
