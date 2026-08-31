export interface OpenGatewayModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
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

const OPENAI_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: true,
	supportsStrictMode: false,
	maxTokensField: "max_tokens",
} as const;

export const OPENGATEWAY_MODELS: OpenGatewayModel[] = [
	{
		id: "moonshotai/kimi-k3-ultrafast",
		name: "Kimi K3 Ultrafast",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		compat: OPENAI_COMPAT,
	},
];
