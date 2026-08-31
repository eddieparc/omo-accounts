import { describe, expect, it } from "vitest";
import { renameStockAccount } from "../src/core/stock-account-rename.js";

class FakeCredentialStore {
	constructor(public current: unknown) {}

	async read(): Promise<unknown> { return structuredClone(this.current); }

	async modify(
		_provider: string,
		update: (current: unknown) => Promise<unknown>,
	): Promise<unknown> {
		this.current = await update(structuredClone(this.current));
		return this.current;
	}
}

async function rename(
	store: FakeCredentialStore,
	provider: string,
	from: string,
	to: string,
): Promise<void> {
	await renameStockAccount({ store, provider, from, to });
}

function pooledCredential() {
	return {
		type: "oauth",
		access: "sentinel-access",
		refresh: "sentinel-refresh",
		expires: 4_102_444_800_000,
		pinned: "login-2",
		accounts: [
			{ name: "default", source: "login", access: "access-a", refresh: "refresh-a", expires: 1_000 },
			{ name: "login-2", source: "login", access: "access-b", refresh: "refresh-b", expires: 2_000 },
		],
	};
}

describe("stock credential account rename", () => {
	it("renames one stored slot while preserving its material, sibling, sentinel, and pin", async () => {
		// Given: a two-slot OAuth pool pinned to login-2.
		const original = pooledCredential();
		const store = new FakeCredentialStore(original);

		// When: login-2 is renamed to work.
		await rename(store, "claude-sdk-oauth", "login-2", "work");

		// Then: only the account name and pin change.
		expect(store.current).toEqual({
			...original,
			pinned: "work",
			accounts: [original.accounts[0], { ...original.accounts[1], name: "work" }],
		});
	});

	it.each([
		{ to: "default", error: /already exists/i },
		{ to: "bad name", error: /invalid account name/i },
		{ to: "-leading", error: /invalid account name/i },
	])("rejects unavailable destination name $to without writing", async ({ to, error }) => {
		// Given: an unchanged two-slot pool.
		const original = pooledCredential();
		const store = new FakeCredentialStore(original);

		// When/Then: duplicate or invalid destinations are rejected atomically.
		await expect(rename(store, "openai-codex", "login-2", to)).rejects.toThrow(error);
		expect(store.current).toEqual(original);
	});

	it("rejects an environment-backed slot", async () => {
		// Given: an environment-owned account represented in the pool.
		const original = {
			type: "oauth",
			access: "flat",
			refresh: "flat-r",
			expires: 1_000,
			accounts: [{ name: "env", source: "env", access: "", refresh: "", expires: 0 }],
		};
		const store = new FakeCredentialStore(original);

		// When/Then: storage never pretends it can rename an environment variable.
		await expect(rename(store, "claude-sdk-oauth", "env", "work")).rejects.toThrow(/environment/i);
		expect(store.current).toEqual(original);
	});

	it("materializes and renames a flat default credential without changing compatibility fields", async () => {
		// Given: a pre-pool flat Codex OAuth credential.
		const original = { type: "oauth", access: "flat-a", refresh: "flat-r", expires: 2_000 };
		const store = new FakeCredentialStore(original);

		// When: its projected default slot is renamed.
		await rename(store, "openai-codex", "default", "personal");

		// Then: flat fields survive and one named stored slot is created.
		expect(store.current).toEqual({
			...original,
			accounts: [{ name: "personal", source: "login", access: "flat-a", refresh: "flat-r", expires: 2_000 }],
		});
	});
});
