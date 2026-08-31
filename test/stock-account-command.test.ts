import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];

class FakeStore {
	constructor(public current: unknown) {}
	async read(): Promise<unknown> { return structuredClone(this.current); }
	async modify(_provider: string, update: (current: unknown) => Promise<unknown>): Promise<unknown> {
		this.current = await update(structuredClone(this.current));
		return this.current;
	}
}

class FakeRuntime {
	constructor(private readonly store: FakeStore) {}
	async login(): Promise<unknown> {
		const fresh = { type: "oauth", access: "new-a", refresh: "new-r", expires: 9_000 };
		const current = this.store.current;
		if (typeof current !== "object" || current === null) throw new Error("missing fake credential");
		const accounts = Reflect.get(current, "accounts");
		if (!Array.isArray(accounts)) throw new Error("missing fake accounts");
		this.store.current = { ...current, accounts: [...accounts, { name: "login-3", source: "login", ...fresh }] };
		return fresh;
	}
	async getAuth(): Promise<unknown> { return undefined; }
}

function sandbox(auth: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "omo-account-command-"));
	dirs.push(dir);
	writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function run(deps: Record<string, unknown>, args: string): Promise<{ text: string; level: string }> {
	const modulePath = "../src/core/stock-account-command.js";
	const loaded: unknown = await import(modulePath).catch(() => ({}));
	const candidate = typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, "runStockAccountCommand") : undefined;
	if (typeof candidate !== "function") throw new Error("runStockAccountCommand is not implemented");
	const result: unknown = await Reflect.apply(candidate, undefined, [deps, args]);
	if (typeof result !== "object" || result === null) throw new Error("invalid command result");
	return { text: String(Reflect.get(result, "text")), level: String(Reflect.get(result, "level")) };
}

function pool() {
	return {
		type: "oauth",
		access: "flat-a",
		refresh: "flat-r",
		expires: 1_000,
		pinned: "work",
		accounts: [
			{ name: "default", source: "login", access: "old-a", refresh: "old-r", expires: 1_000 },
			{ name: "work", source: "login", access: "work-a", refresh: "work-r", expires: 2_000 },
		],
	};
}

describe("/omo-account command", () => {
	it("lists one supported provider without exposing credentials", async () => {
		// Given: a sandbox with two Codex slots.
		const credential = pool();
		const agentDir = sandbox({ "openai-codex": credential });
		const store = new FakeStore(credential);

		// When: the provider list action runs.
		const output = await run({ agentDir, store, runtime: new FakeRuntime(store) }, "openai-codex list");

		// Then: both names appear and tokens do not.
		expect(output.level).toBe("info");
		expect(output.text).toMatch(/openai-codex\s+default/);
		expect(output.text).toMatch(/openai-codex\s+work/);
		expect(output.text).not.toContain("work-a");
	});

	it("routes rename through the atomic credential mutation", async () => {
		// Given: a stored two-slot pool.
		const credential = pool();
		const store = new FakeStore(credential);

		// When: work is renamed to office.
		const output = await run({ agentDir: sandbox({ "openai-codex": credential }), store, runtime: new FakeRuntime(store) }, "openai-codex rename work office");

		// Then: the command reports success and the pin follows.
		expect(output).toMatchObject({ level: "info" });
		expect(output.text).toMatch(/office/);
		expect(store.current).toMatchObject({ pinned: "office" });
	});

	it("routes relogin through slot reconciliation", async () => {
		// Given: a stored pool and deterministic OAuth runtime.
		const credential = pool();
		const store = new FakeStore(credential);

		// When: the pinned work slot is re-logged in.
		const output = await run({ agentDir: sandbox({ "openai-codex": credential }), store, runtime: new FakeRuntime(store) }, "openai-codex relogin work");

		// Then: success is reported and the target receives fresh material.
		expect(output).toMatchObject({ level: "info" });
		expect(output.text).toMatch(/work/);
		expect(JSON.stringify(store.current)).toContain("new-a");
		expect(JSON.stringify(store.current)).not.toContain("login-3");
	});

	it("rejects unsupported providers and malformed actions", async () => {
		// Given: an empty sandbox and inert runtime.
		const store = new FakeStore(undefined);
		const deps = { agentDir: sandbox({}), store, runtime: new FakeRuntime(store) };

		// When/Then: the command stays within Claude and Codex.
		expect(await run(deps, "anthropic list")).toMatchObject({ level: "error" });
		expect(await run(deps, "openai-codex rename only-one-name")).toMatchObject({ level: "error" });
	});
});
