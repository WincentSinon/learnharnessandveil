import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { CloudSyncSection, cloudSyncStatusText, type CloudSyncStatus } from "../components/settings/cloud-sync-section.tsx";

(globalThis as Record<string, unknown>).React = React;
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const initial = (values: Partial<CloudSyncStatus> = {}): CloudSyncStatus => ({ configured: false, url: "", keyConfigured: false, account: null, enabled: false, state: "unconfigured", pendingCount: 0, ...values });
const connected = (values: Partial<CloudSyncStatus> = {}) => initial({ configured: true, url: "https://project.supabase.co", keyConfigured: true, account: { id: "learner-id", email: "learner@example.invalid" }, state: "idle", ...values });
const element = <T extends HTMLElement = HTMLElement>(id: string) => {
	const found = host?.querySelector<T>(`[data-testid="${id}"]`); assert.ok(found, `Missing ${id}`); return found;
};
async function mount() {
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<CloudSyncSection />));
}
async function click(id: string) { await act(async () => element(id).click()); }
async function submit(id: string) { await act(async () => element(id).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))); }
function fixture(status: CloudSyncStatus, post: (body: Record<string, unknown>) => Response | Promise<Response> = () => Response.json({ status })) {
	const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
	globalThis.fetch = async (url, init) => {
		const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
		calls.push({ url: String(url), body });
		assert.equal(String(url), "/api/cloud-sync");
		return body ? post(body) : Response.json({ status });
	};
	return calls;
}
afterEach(async () => {
	await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined;
	globalThis.fetch = originalFetch;
	if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else Reflect.deleteProperty(globalThis, "navigator");
});

test("opening Cloud sync stays local until the user configures, signs in and enables it", async () => {
	const calls = fixture(initial()); await mount();
	assert.deepEqual(calls, [{ url: "/api/cloud-sync", body: undefined }]);
	assert.equal(element<HTMLButtonElement>("toggle-automatic-cloud-sync").disabled, true);
	assert.equal(element<HTMLButtonElement>("cloud-sync-now").disabled, true);
	assert.equal(element<HTMLInputElement>("cloud-email").disabled, true);
	assert.equal(element<HTMLInputElement>("cloud-project-key").type, "password");
	assert.match(element("cloud-sync-status").textContent!, /Saved locally/);
});

test("a saved project key stays masked and blank reuse saves without enabling uploads", async () => {
	const signedOut = connected({ account: null, state: "signed-out" });
	const calls = fixture(signedOut, body => { assert.deepEqual(body, { action: "configure", url: signedOut.url, key: "" }); return Response.json({ status: signedOut }); });
	await mount();
	assert.equal(element<HTMLInputElement>("cloud-project-url").value, signedOut.url);
	assert.equal(element<HTMLInputElement>("cloud-project-key").value, "");
	assert.match(element<HTMLInputElement>("cloud-project-key").placeholder, /leave blank/);
	await submit("cloud-sync-project-form");
	assert.equal(calls.filter(value => value.body).length, 1);
	assert.match(element("cloud-sync-message").textContent!, /Sign in, then enable/);
	assert.equal(element<HTMLButtonElement>("toggle-automatic-cloud-sync").disabled, true);
});

test("automatic uploads require explicit opt-in and notify the app after actions", async () => {
	let notifications = 0;
	const changed = () => { notifications++; };
	window.addEventListener("veil:cloud-sync-settings", changed);
	const calls = fixture(connected(), body => {
		if (body.action === "enable") { assert.equal(body.enabled, true); return Response.json({ status: connected({ enabled: true }) }); }
		assert.equal(body.action, "sync"); return Response.json({ status: connected({ enabled: true, state: "synced", lastSyncedAt: "2026-11-05T12:00:00Z" }) });
	});
	try {
		await mount(); assert.equal(calls.filter(value => value.body).length, 0);
		await click("toggle-automatic-cloud-sync");
		assert.equal(element("toggle-automatic-cloud-sync").getAttribute("aria-checked"), "true");
		await click("cloud-sync-now");
		assert.match(element("cloud-sync-status").textContent!, /Synced/);
		assert.doesNotMatch(element("cloud-sync-status").textContent!, /Not synced yet/);
		assert.equal(notifications, 2);
	} finally { window.removeEventListener("veil:cloud-sync-settings", changed); }
});

test("sign-out keeps the local library available and turns sync controls off", async () => {
	fixture(connected({ enabled: true }), body => { assert.deepEqual(body, { action: "sign-out" }); return Response.json({ status: connected({ account: null, enabled: false, state: "signed-out" }) }); });
	await mount(); await click("cloud-sign-out");
	assert.match(element("cloud-sync-message").textContent!, /local sessions remain available/);
	assert.equal(element<HTMLButtonElement>("cloud-sync-now").disabled, true);
	assert.ok(element("cloud-auth-form"));
});

test("the SQL helper copies the actual same-origin setup without touching account data", async () => {
	const sql = "-- fixture setup\nselect 1;";
	let copied = "";
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (value: string) => { copied = value; } } } });
	const calls: string[] = [];
	globalThis.fetch = async url => { calls.push(String(url)); return String(url) === "/api/cloud-sync/setup" ? new Response(sql) : Response.json({ status: initial() }); };
	await mount(); await click("cloud-copy-setup");
	assert.equal(copied, sql); assert.deepEqual(calls, ["/api/cloud-sync", "/api/cloud-sync/setup"]);
	assert.match(element("cloud-sync-message").textContent!, /Run it once/);
	assert.equal(element<HTMLAnchorElement>("cloud-download-setup").getAttribute("href"), "/api/cloud-sync/setup");
});

test("a failed sync keeps controls usable and shows the actionable server error", async () => {
	fixture(connected({ enabled: true }), () => Response.json({ error: "Run setup SQL before enabling cloud sync.", status: connected({ enabled: true, setupRequired: true, state: "error" }) }, { status: 409 }));
	await mount(); await click("cloud-sync-now");
	assert.match(element("cloud-sync-error").textContent!, /Run setup SQL/);
	assert.equal(element<HTMLButtonElement>("cloud-sync-now").disabled, false);
	assert.match(element("cloud-sync-status").textContent!, /needs attention/);
});

test("unavailable local service does not imply the local sessions were lost", async () => {
	globalThis.fetch = async () => { throw new Error("connection reset fixture"); };
	await mount();
	assert.match(element("cloud-sync-error").textContent!, /local sessions are still available/);
	assert.doesNotMatch(element("cloud-sync-error").textContent!, /connection reset fixture/);
});

test("status copy distinguishes successful cloud sync from an offline local save", () => {
	assert.equal(cloudSyncStatusText(connected({ enabled: true, state: "synced" })), "Synced");
	assert.match(cloudSyncStatusText(connected({ enabled: true, state: "offline" })), /Offline/);
	assert.match(cloudSyncStatusText(connected({ state: "idle" })), /automatic sync is off/);
	assert.match(cloudSyncStatusText(initial({ configured: true, state: "signed-out" })), /sign in/);
});

test("preserved conflicts tell the learner where to find study and reading copies", async () => {
	fixture(connected({ enabled: true, state: "synced", conflictCount: 2 })); await mount();
	assert.match(element("cloud-sync-conflicts").textContent!, /2 conflicting versions were preserved/);
	assert.match(element("cloud-sync-conflicts").textContent!, /Sessions and My reading/);
});
