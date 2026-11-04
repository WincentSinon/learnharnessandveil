import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

const require = createRequire(import.meta.url);
const { createOverlayController, normalizeOpacity, validateSessionId, readPdf, MAX_PDF_BYTES, OVERLAY_SHORTCUT } = require("../electron/overlay.cjs");
const origin = "http://127.0.0.1:37123";

test("native opacity is bounded without accepting coercion or nonfinite numbers", () => {
	assert.equal(normalizeOpacity(0.53), 0.53);
	assert.equal(normalizeOpacity(-1), 0.2);
	assert.equal(normalizeOpacity(3), 1);
	for (const value of [NaN, Infinity, "0.5", null, undefined]) assert.throws(() => normalizeOpacity(value), /finite number/);
});

test("session navigation accepts IDs and refuses URLs or path traversal", () => {
	assert.equal(validateSessionId("chat_a-B_12"), "chat_a-B_12");
	for (const value of ["", "../keys", "https://example.com", "a/b", "x".repeat(101), null]) assert.throws(() => validateSessionId(value), /Invalid session/);
});

test("the picker reader validates type, file size, and PDF bytes before returning a copy", async () => {
	const bytes = Buffer.from("%PDF-1.7\nmock document");
	let reads = 0;
	const io = {
		stat: async () => ({ isFile: () => true, size: bytes.length }),
		readFile: async () => { reads++; return bytes; },
	};
	const value = await readPdf(path.join(os.tmpdir(), "test.PDF"), io);
	assert.equal(value.name, "test.PDF");
	assert(value.data instanceof Uint8Array);
	assert.deepEqual([...value.data], [...bytes]);
	value.data[0] = 0;
	assert.equal(bytes[0], 37, "IPC payload does not mutate the loaded Buffer");
	await assert.rejects(readPdf("notes.txt", io), /Choose a PDF/);
	assert.equal(reads, 1);
	await assert.rejects(readPdf("large.pdf", { ...io, stat: async () => ({ isFile: () => true, size: MAX_PDF_BYTES + 1 }) }), /100 MB/);
	assert.equal(reads, 1, "oversized files are refused before reading contents");
	await assert.rejects(readPdf("folder.pdf", { ...io, stat: async () => ({ isFile: () => false, size: 1 }) }), /Choose a PDF/);
	await assert.rejects(readPdf("fake.pdf", { ...io, readFile: async () => Buffer.from("not a PDF") }), /not a valid PDF/);
});

class FakeWindow extends EventEmitter {
	webContents: { mainFrame: { url: string }; getURL: () => string };
	visible = false;
	minimized = false;
	destroyed = false;
	opacity = 1;
	pinned = false;
	focusCount = 0;
	constructor(url: string) {
		super();
		this.webContents = { mainFrame: { url }, getURL: () => this.webContents.mainFrame.url };
	}
	isDestroyed() { return this.destroyed; }
	isMinimized() { return this.minimized; }
	isVisible() { return this.visible; }
	setAlwaysOnTop(value: boolean) { this.pinned = value; }
	setOpacity(value: number) { this.opacity = value; }
	restore() { this.minimized = false; }
	show() { this.visible = true; }
	hide() { this.visible = false; }
	focus() { this.focusCount++; }
	async loadURL(url: string) { this.webContents.mainFrame.url = url; }
}

async function fixture(t: TestContext, registered = true) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "lh-overlay-test-"));
	const app = Object.assign(new EventEmitter(), { getPath: () => directory });
	const main = new FakeWindow(`${origin}/`);
	const windows = [main];
	const trustedWindows = new Set(windows);
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	let shortcut: (() => void) | undefined;
	const unregistered: string[] = [];
	const controller = createOverlayController({
		app,
		BrowserWindow: { fromWebContents: (contents: unknown) => windows.find(win => win.webContents === contents) ?? null },
		dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
		ipcMain: {
			handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
			removeHandler: (channel: string) => handlers.delete(channel),
		},
		globalShortcut: {
			isRegistered: () => false,
			register: (_accelerator: string, callback: () => void) => { shortcut = callback; return registered; },
			unregister: (accelerator: string) => unregistered.push(accelerator),
		},
		origin,
		trustedWindows,
		trustedSender: (event: { sender: FakeWindow["webContents"]; senderFrame: FakeWindow["webContents"]["mainFrame"] }) =>
			event.senderFrame === event.sender.mainFrame && new URL(event.senderFrame.url).origin === origin,
		createReaderWindow: (url: string) => {
			const win = new FakeWindow(url);
			windows.push(win);
			trustedWindows.add(win);
			return win;
		},
		getMainWindow: () => main,
		createMainWindow: () => { throw new Error("Existing workspace should be reused"); },
	});
	const event = (win: FakeWindow) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
	const invoke = (channel: string, win: FakeWindow, ...args: unknown[]) => handlers.get(`lh:overlay:${channel}`)!(event(win), ...args);
	t.after(async () => { controller.dispose(); await rm(directory, { recursive: true, force: true }); });
	return { controller, main, windows, invoke, event, handlers, directory, unregistered, shortcut: () => shortcut?.() };
}

test("only owned main frames can open a reader; reader-only controls reject the workspace", async t => {
	const { main, windows, invoke, handlers, event } = await fixture(t);
	await invoke("open", main);
	assert.equal(windows.length, 2);
	const reader = windows[1]!;
	assert.equal(reader.webContents.getURL(), `${origin}/reader`);
	assert.equal(reader.pinned, true);
	assert.equal(reader.opacity, 1);
	await invoke("open", main);
	assert.equal(windows.length, 2, "reopening reuses the reader and preserves its document");
	await assert.rejects(Promise.resolve().then(() => invoke("opacity", main, 0.5)), /floating reader/);
	await assert.rejects(Promise.resolve().then(() => invoke("pdf", main)), /floating reader/);
	const unowned = new FakeWindow(`${origin}/reader`);
	await assert.rejects(Promise.resolve().then(() => invoke("open", unowned)), /Untrusted/);
	await assert.rejects(Promise.resolve().then(() => handlers.get("lh:overlay:open")!({ ...event(main), senderFrame: { url: `${origin}/` } })), /Untrusted/);
	reader.webContents.mainFrame.url = "https://untrusted.invalid/reader";
	await assert.rejects(Promise.resolve().then(() => invoke("pin", reader, false)), /Untrusted/);
});

test("native controls affect only the reader, preserve validated state, and handle picker cancel", async t => {
	const { controller, main, windows, invoke, directory } = await fixture(t);
	await invoke("open", main);
	const reader = windows[1]!;
	assert.equal(await invoke("opacity", reader, 0.53), 0.53);
	assert.equal(reader.opacity, 0.53);
	assert.equal(main.opacity, 1);
	assert.equal(await invoke("pin", reader, false), false);
	assert.equal(reader.pinned, false);
	assert.equal(await invoke("pdf", reader), null);
	await assert.rejects(Promise.resolve().then(() => invoke("pin", reader, "false")), /true or false/);
	assert.deepEqual(await invoke("state", main), { opacity: 0.53, pinned: false, shortcutAvailable: true });
	controller.dispose();
	assert.deepEqual(JSON.parse(await readFile(path.join(directory, "reader-window.json"), "utf8")), { opacity: 0.53, pinned: false });
});

test("session opening is explicit, validates the path, and focuses the existing workspace", async t => {
	const { main, invoke } = await fixture(t);
	await invoke("session", main, "chat_example-12");
	assert.equal(main.webContents.getURL(), `${origin}/chat/chat_example-12`);
	assert.equal(main.visible, true);
	assert.equal(main.focusCount, 1);
	await assert.rejects(Promise.resolve().then(() => invoke("session", main, "../api/keys")), /Invalid session/);
});

test("hiding and the optional shortcut preserve the reader instead of creating duplicate windows", async t => {
	const { controller, main, windows, invoke, shortcut, unregistered } = await fixture(t);
	await invoke("open", main);
	const reader = windows[1]!;
	reader.visible = true;
	shortcut();
	assert.equal(reader.visible, false);
	shortcut();
	assert.equal(reader.visible, true);
	assert.equal(windows.length, 2);
	let prevented = false;
	reader.emit("close", { preventDefault: () => { prevented = true; } });
	assert.equal(prevented, true);
	assert.equal(reader.visible, false);
	controller.dispose();
	assert(unregistered.includes(OVERLAY_SHORTCUT));
	const unavailable = await fixture(t, false);
	assert.equal(unavailable.controller.state().shortcutAvailable, false, "an occupied shortcut remains optional");
});
