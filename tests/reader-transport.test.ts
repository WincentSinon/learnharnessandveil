import assert from "node:assert/strict";
import test from "node:test";
import { createReaderStudyClient } from "../components/reader-study-client.ts";
import { READER_STUDIES_KEY } from "../src/core/reader-study.ts";

const passage = { documentName: "Example.pdf", page: 7, text: "Only this selected passage is sent.", question: "Explain the connection.", mode: "teach" as const };
const configured = { settings: { models: {
	strong: { model: { provider: "test", id: "strong" } },
	cheap: { model: { provider: "test", id: "cheap" } },
	vision: { model: { provider: "test", id: "vision" } },
} } };

function store() {
	const data = new Map<string, string>();
	return { data, getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => { data.set(key, value); } };
}

function transport(handler?: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetchImpl = (async (url, init) => {
		calls.push({ url: String(url), init });
		if (handler) return handler(String(url), init);
		if (url === "/api/settings") return Response.json(configured);
		if (url === "/api/chats" && init?.method === "POST") return Response.json({ id: "chat_reader", title: "A focused study" });
		if (url === "/api/reader/studies") return Response.json({ records: [] });
		if (url === "/api/chat") return Response.json({ ok: true });
		throw new Error(`Unexpected request: ${url}`);
	}) as typeof fetch;
	return { calls, fetchImpl };
}

test("background start persists source mapping before one admitted text input and does not subscribe to a stream", async () => {
	const storage = store();
	let sourceSavedBeforeAdmission = false;
	const { calls, fetchImpl } = transport((url, init) => {
		if (url === "/api/settings") return Response.json(configured);
		if (url === "/api/chats") return Response.json({ id: "chat_reader", title: "A focused study" });
		if (url === "/api/reader/studies") return Response.json({ records: [] });
		if (url === "/api/chat") {
			const saved = JSON.parse(storage.getItem(READER_STUDIES_KEY) || "[]");
			sourceSavedBeforeAdmission = saved[0]?.id === "chat_reader" && saved[0]?.state === "starting";
			const body = JSON.parse(String(init?.body));
			assert.equal(body.chatId, "chat_reader");
			assert.equal(body.input.type, "text");
			assert.match(body.input.text, /Only this selected passage/);
			assert.match(body.input.text, /Explain the connection/);
			assert.match(body.input.text, /"page": 7/);
			assert.match(body.input.text, /not instructions/);
			return Response.json({ ok: true });
		}
		throw new Error("Unexpected request");
	});
	const client = createReaderStudyClient({ fetchImpl, storage });
	assert.deepEqual(await client.start(passage), { id: "chat_reader", title: "A focused study" });
	assert.equal(sourceSavedBeforeAdmission, true);
	assert.deepEqual(calls.map(call => call.url), ["/api/settings", "/api/chats", "/api/reader/studies", "/api/chat"]);
	assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { title: "Study: Example.pdf · p. 7" });
	assert.equal(client.list()[0]?.state, "working");
	assert.equal(client.list()[0]?.page, 7);
	assert.equal(client.list()[0]?.documentName, "Example.pdf");
});

test("practice creates a native practice session and uses its learning prompt", async () => {
	const { calls, fetchImpl } = transport();
	const client = createReaderStudyClient({ fetchImpl });
	await client.start({ ...passage, mode: "practice" });
	assert.equal(JSON.parse(String(calls[1]?.init?.body)).kind, "practice");
	assert.match(JSON.parse(String(calls.find(call => call.url === "/api/chat")?.init?.body)).input.text, /one problem at a time/);
});

test("missing model setup and invalid passage never create empty sessions", async () => {
	const { calls, fetchImpl } = transport(() => Response.json({ settings: null }));
	const client = createReaderStudyClient({ fetchImpl });
	await assert.rejects(client.start({ ...passage, page: -1 }), /valid PDF page/);
	assert.equal(calls.length, 0);
	await assert.rejects(client.start(passage), /Configure the strong, cheap, and vision models/);
	assert.deepEqual(calls.map(call => call.url), ["/api/settings"]);
	assert.deepEqual(client.list(), []);
});

test("ambiguous admission failure keeps a session to inspect and never automatically retries", async () => {
	const { calls, fetchImpl } = transport(url => {
		if (url === "/api/settings") return Response.json(configured);
		if (url === "/api/chats") return Response.json({ id: "chat_uncertain" });
		throw new Error("Socket ended after the server accepted the input");
	});
	const client = createReaderStudyClient({ fetchImpl, storage: store() });
	await assert.rejects(client.start(passage), /may already be working/);
	assert.equal(calls.filter(call => call.url === "/api/chat").length, 1);
	assert.equal(client.list()[0]?.id, "chat_uncertain");
	assert.equal(client.list()[0]?.state, "error");
	assert.match(client.list()[0]?.error || "", /before retrying/);
});

test("known admission refusal is retained until canonical active or waiting truth appears", async () => {
	let chat: Record<string, unknown> = { id: "chat_reader", title: "Retained", busy: false };
	const { fetchImpl } = transport((url, init) => {
		if (url === "/api/settings") return Response.json(configured);
		if (url === "/api/chats" && init?.method === "POST") return Response.json({ id: "chat_reader" });
		if (url === "/api/chats") return Response.json({ chats: [chat] });
		return Response.json({ error: "Provider is not ready." }, { status: 503 });
	});
	const client = createReaderStudyClient({ fetchImpl, storage: store() });
	await assert.rejects(client.start(passage), /Provider is not ready/);
	assert.equal((await client.refresh())[0]?.state, "error");
	chat = { ...chat, busy: true, pendingQuestion: true };
	assert.equal((await client.refresh())[0]?.state, "working");
	assert.equal(client.list()[0]?.error, undefined);
	chat = { ...chat, busy: false };
	assert.equal((await client.refresh())[0]?.state, "waiting");
	chat = { ...chat, pendingQuestion: false };
	assert.equal((await client.refresh())[0]?.state, "ready");
});

test("malformed session IDs never reach admission", async () => {
	const { calls, fetchImpl } = transport(url => url === "/api/settings"
		? Response.json(configured) : Response.json({ id: "../settings" }));
	const client = createReaderStudyClient({ fetchImpl });
	await assert.rejects(client.start(passage), /invalid session/);
	assert.equal(calls.length, 2);
	assert.deepEqual(client.list(), []);
});

test("storage errors preserve an in-memory session and do not duplicate model input", async () => {
	const { calls, fetchImpl } = transport();
	const client = createReaderStudyClient({ fetchImpl, storage: {
		getItem: () => { throw new Error("Storage blocked"); },
		setItem: () => { throw new Error("Quota exceeded"); },
	}, onChange: () => { throw new Error("View callback failed"); } });
	await client.start({ ...passage, text: "a".repeat(800) });
	assert.equal(client.list()[0]?.quote.length, 300);
	assert.equal(client.list()[0]?.state, "working");
	assert.equal(calls.filter(call => call.url === "/api/chat").length, 1);
});

test("a silent storage write failure falls back to memory instead of erasing the new session", async () => {
	const { fetchImpl } = transport();
	const client = createReaderStudyClient({ fetchImpl, storage: { getItem: () => null, setItem: () => {} } });
	await client.start(passage);
	assert.equal(client.list()[0]?.id, "chat_reader");
	assert.equal(client.list()[0]?.state, "working");
});

test("canonical deletion does not claim that an absent session is ready", async () => {
	const { fetchImpl } = transport((url, init) => {
		if (url === "/api/settings") return Response.json(configured);
		if (url === "/api/chats" && init?.method === "POST") return Response.json({ id: "chat_reader" });
		if (url === "/api/chats") return Response.json({ chats: [] });
		return Response.json({ ok: true });
	});
	const client = createReaderStudyClient({ fetchImpl });
	await client.start(passage);
	const record = (await client.refresh())[0];
	assert.equal(record?.state, "error");
	assert.match(record?.error || "", /no longer exists/);
});

test("another reader window can restore the local source index without another model call", async () => {
	const storage = store();
	const first = transport();
	await createReaderStudyClient({ fetchImpl: first.fetchImpl, storage }).start(passage);
	const second = transport(() => { throw new Error("No network expected"); });
	const restored = createReaderStudyClient({ fetchImpl: second.fetchImpl, storage }).list();
	assert.equal(restored[0]?.id, "chat_reader");
	assert.equal(restored[0]?.quote, passage.text);
	assert.equal(second.calls.length, 0);
});

test("an older list snapshot cannot mark a newly created background session as deleted", async () => {
	let releaseSnapshot: ((response: Response) => void) | undefined;
	const { fetchImpl } = transport((url, init) => {
		if (url === "/api/settings") return Response.json(configured);
		if (url === "/api/chats" && init?.method === "POST") return Response.json({ id: "chat_reader" });
		if (url === "/api/chats") return new Promise<Response>(resolve => { releaseSnapshot = resolve; });
		return Response.json({ ok: true });
	});
	const client = createReaderStudyClient({ fetchImpl });
	const oldSnapshot = client.refresh();
	await client.start(passage);
	assert.ok(releaseSnapshot);
	releaseSnapshot(Response.json({ chats: [] }));
	await oldSnapshot;
	assert.equal(client.list()[0]?.state, "working");
	assert.equal(client.list()[0]?.error, undefined);
});

test("overlapping refreshes adopt the newer snapshot when responses arrive out of order", async () => {
	const snapshots: ((response: Response) => void)[] = [];
	const { fetchImpl } = transport((url, init) => {
		if (url === "/api/settings") return Response.json(configured);
		if (url === "/api/chats" && init?.method === "POST") return Response.json({ id: "chat_reader" });
		if (url === "/api/chats") return new Promise<Response>(resolve => { snapshots.push(resolve); });
		return Response.json({ ok: true });
	});
	const client = createReaderStudyClient({ fetchImpl });
	await client.start(passage);
	const older = client.refresh();
	const newer = client.refresh();
	snapshots[1]?.(Response.json({ chats: [{ id: "chat_reader", busy: false, pendingQuestion: true }] }));
	await newer;
	snapshots[0]?.(Response.json({ chats: [{ id: "chat_reader", busy: true }] }));
	await older;
	assert.equal(client.list()[0]?.state, "waiting");
});

test("a second computer restores cloud passage links with empty browser storage and no AI admission", async () => {
	const saved = { id: "chat_remote", title: "Study Linux", documentName: "Linux.pdf", page: 3,
		quote: "A module adds functionality.", mode: "teach", createdAt: "2026-11-05T08:00:00.000Z", state: "ready" };
	const { calls, fetchImpl } = transport((url, init) => {
		if (url === "/api/reader/studies" && !init?.method) return Response.json({ records: [saved] });
		if (url === "/api/chats") return Response.json({ chats: [{ id: saved.id, pendingQuestion: true, title: saved.title }] });
		throw new Error(`Unexpected request ${url}`);
	});
	const client = createReaderStudyClient({ fetchImpl, storage: store() });
	assert.deepEqual(client.list(), []);
	const records = await client.refresh();
	assert.equal(records[0]?.id, saved.id); assert.equal(records[0]?.state, "waiting");
	assert.equal(records[0]?.page, 3); assert.equal(calls.some(call => call.url === "/api/chat"), false);
});

test("legacy browser links are migrated to the durable store during refresh", async () => {
	const storage = store(); storage.setItem(READER_STUDIES_KEY, JSON.stringify([{ id: "chat_legacy", title: "Legacy", documentName: "Old.pdf", page: 1,
		quote: "An older passage.", mode: "teach", createdAt: "2026-11-04T08:00:00.000Z", state: "ready" }]));
	let migrated: unknown[] = [];
	const { fetchImpl } = transport((url, init) => {
		if (url === "/api/chats") return Response.json({ chats: [{ id: "chat_legacy" }] });
		if (url === "/api/reader/studies") {
			if (init?.method === "POST") migrated = JSON.parse(String(init.body)).records;
			return Response.json({ records: migrated });
		}
		throw new Error("Unexpected request");
	});
	await createReaderStudyClient({ fetchImpl, storage }).refresh();
	assert.equal((migrated[0] as { id: string }).id, "chat_legacy");
});
