import { describe, expect, it } from "vitest";

class FakeCredentialStore {
	constructor(public current: unknown) {}

	async read(_provider: string): Promise<unknown> {
		return structuredClone(this.current);
	}

	async modify(_provider: string, update: (current: unknown) => Promise<unknown>): Promise<unknown> {
		this.current = await update(structuredClone(this.current));
		return this.current;
	}
}

interface LoginInteraction {
	readonly signal?: AbortSignal;
	readonly prompt: (spec: unknown) => Promise<string>;
	readonly notify: (event: unknown) => void;
}

class FakeRuntime {
	calls = 0;

	constructor(
		private readonly loginAction: (
			provider: string,
			type: string,
			interaction: LoginInteraction,
		) => Promise<unknown>,
	) {}

	async login(provider: string, type: string, interaction: LoginInteraction): Promise<unknown> {
		this.calls += 1;
		return this.loginAction(provider, type, interaction);
	}
}

async function relogin(
	store: FakeCredentialStore,
	runtime: FakeRuntime,
	provider: string,
	name: string,
): Promise<void> {
	const modulePath = "../src/core/stock-account-relogin.js";
	const loaded: unknown = await import(modulePath).catch(() => ({}));
	const candidate = typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, "reloginStockAccount") : undefined;
	if (typeof candidate !== "function") throw new Error("reloginStockAccount is not implemented");
	await Reflect.apply(candidate, undefined, [{
		store,
		runtime,
		provider,
		name,
		interaction: { prompt: async () => "", notify: () => undefined },
	}]);
}

function oauthPool() {
	return {
		type: "oauth",
		access: "flat-default-a",
		refresh: "flat-default-r",
		expires: 1_000,
		pinned: "work",
		accounts: [
			{ name: "default", source: "login", access: "old-default-a", refresh: "old-default-r", expires: 1_000 },
			{ name: "work", source: "login", access: "old-work-a", refresh: "old-work-r", expires: 2_000 },
		],
	};
}

describe("stock account slot-specific relogin", () => {
	it("replaces only the target Codex slot and removes the generated login slot", async () => {
		// Given: runtime login appends login-3 while returning a fresh flat OAuth credential.
		const original = oauthPool();
		const store = new FakeCredentialStore(original);
		const fresh = { type: "oauth", access: "new-work-a", refresh: "new-work-r", expires: 9_000 };
		const runtime = new FakeRuntime(async () => {
			store.current = {
				...original,
				accounts: [...original.accounts, { name: "login-3", source: "login", access: fresh.access, refresh: fresh.refresh, expires: fresh.expires }],
			};
			return fresh;
		});

		// When: work is re-authenticated.
		await relogin(store, runtime, "openai-codex", "work");

		// Then: work keeps its name, siblings/pin survive, and login-3 is gone.
		expect(store.current).toEqual({
			...original,
			accounts: [original.accounts[0], { name: "work", source: "login", access: "new-work-a", refresh: "new-work-r", expires: 9_000 }],
		});
	});

	it("uses the same target replacement contract for Claude sentinel credentials", async () => {
		// Given: a Claude sentinel pool and a fresh OAuth result.
		const original = {
			type: "oauth",
			access: "claude-sdk-oauth-managed",
			refresh: "claude-sdk-oauth-managed",
			expires: 4_102_444_800_000,
			pinned: "login-2",
			accounts: [
				{ name: "default", source: "login", access: "claude-a", refresh: "claude-r", expires: 1_000 },
				{ name: "login-2", source: "login", access: "claude-b", refresh: "claude-s", expires: 2_000 },
			],
		};
		const store = new FakeCredentialStore(original);
		const fresh = { type: "oauth", access: "claude-new", refresh: "claude-new-r", expires: 8_000 };
		const runtime = new FakeRuntime(async () => {
			store.current = { ...original, accounts: [...original.accounts, { name: "login-3", source: "login", ...fresh }] };
			return fresh;
		});

		// When: login-2 is re-authenticated.
		await relogin(store, runtime, "claude-sdk-oauth", "login-2");

		// Then: sentinel fields and pin remain while only login-2 tokens rotate.
		expect(store.current).toEqual({
			...original,
			accounts: [original.accounts[0], { name: "login-2", source: "login", access: "claude-new", refresh: "claude-new-r", expires: 8_000 }],
		});
	});

	it("leaves storage unchanged when interactive login is cancelled", async () => {
		// Given: a runtime that cancels before writing.
		const original = oauthPool();
		const store = new FakeCredentialStore(original);
		const runtime = new FakeRuntime(async () => { throw new Error("Login cancelled"); });

		// When/Then: cancellation propagates and no account changes.
		await expect(relogin(store, runtime, "openai-codex", "work")).rejects.toThrow(/cancelled/i);
		expect(store.current).toEqual(original);
	});

	it("rejects a missing or environment account before starting OAuth", async () => {
		// Given: an environment-backed slot and a runtime that must not run.
		const original = {
			type: "oauth",
			access: "flat",
			refresh: "flat-r",
			expires: 1_000,
			accounts: [{ name: "env", source: "env", access: "", refresh: "", expires: 0 }],
		};
		const store = new FakeCredentialStore(original);
		const runtime = new FakeRuntime(async () => ({ type: "oauth", access: "x", refresh: "y", expires: 2_000 }));

		// When/Then: both invalid targets fail before OAuth begins.
		await expect(relogin(store, runtime, "claude-sdk-oauth", "env")).rejects.toThrow(/environment/i);
		await expect(relogin(store, runtime, "claude-sdk-oauth", "missing")).rejects.toThrow(/does not exist/i);
		expect(runtime.calls).toBe(0);
		expect(store.current).toEqual(original);
	});
});
