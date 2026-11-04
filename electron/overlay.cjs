"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createSpeechController } = require("./speech.cjs");

const OVERLAY_SHORTCUT = "Control+Alt+Space";
const MAX_PDF_BYTES = 100 * 1024 * 1024;

function normalizeOpacity(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Opacity must be a finite number.");
	return Math.max(0.2, Math.min(1, value));
}

function validateSessionId(value) {
	if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error("Invalid session ID.");
	return value;
}

/** Only a file returned by the native picker reaches this function. */
async function readPdf(filePath, io = fs.promises) {
	if (typeof filePath !== "string" || path.extname(filePath).toLowerCase() !== ".pdf") throw new Error("Choose a PDF file.");
	const stat = await io.stat(filePath);
	if (!stat.isFile()) throw new Error("Choose a PDF file.");
	if (stat.size > MAX_PDF_BYTES) throw new Error("Choose a PDF smaller than 100 MB.");
	const bytes = await io.readFile(filePath);
	if (bytes.length > MAX_PDF_BYTES) throw new Error("Choose a PDF smaller than 100 MB.");
	if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new Error("This file is not a valid PDF.");
	return { name: path.basename(filePath), data: new Uint8Array(bytes) };
}

/** Native capabilities for one owned reader window; no new HTTP endpoint or token. */
function createOverlayController({
	app, BrowserWindow, dialog, ipcMain, globalShortcut, origin, trustedWindows, trustedSender,
	createReaderWindow, getMainWindow, createMainWindow, log = () => {}, createSpeech = createSpeechController,
}) {
	const preferencesPath = path.join(app.getPath("userData"), "reader-window.json");
	let preferences = { opacity: 1, pinned: true };
	try {
		const saved = JSON.parse(fs.readFileSync(preferencesPath, "utf8"));
		preferences = {
			opacity: typeof saved.opacity === "number" && Number.isFinite(saved.opacity) ? normalizeOpacity(saved.opacity) : 1,
			pinned: typeof saved.pinned === "boolean" ? saved.pinned : true,
		};
	} catch { /* First launch or a corrupt preference file uses readable defaults. */ }
	let reader = null;
	let quitting = false;
	let shortcutAvailable = false;
	let saveTimer = null;
	const handlers = [];
	const state = () => ({ ...preferences, shortcutAvailable });
	const liveReader = () => reader && !reader.isDestroyed() ? reader : null;
	const speech = createSpeech({ onState(value) {
		const win = liveReader();
		if (!win) return;
		try {
			const url = new URL(win.webContents.getURL());
			if (url.origin === origin && ["/reader", "/reader/"].includes(url.pathname)) win.webContents.send("lh:overlay:speech-state", value);
		} catch { /* A closing or navigating renderer has no state subscriber. */ }
	} });

	function persist() {
		clearTimeout(saveTimer);
		saveTimer = null;
		try {
			fs.mkdirSync(path.dirname(preferencesPath), { recursive: true });
			fs.writeFileSync(`${preferencesPath}.tmp`, JSON.stringify(preferences));
			fs.renameSync(`${preferencesPath}.tmp`, preferencesPath);
		} catch (error) { log(`reader preferences: ${error?.message ?? error}`); }
	}
	function schedulePersist() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(persist, 200);
	}
	function authorized(event, readerOnly = false) {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win || !trustedWindows.has(win) || !trustedSender(event, origin, BrowserWindow)) throw new Error("Untrusted reader request.");
		if (readerOnly) {
			const pathname = new URL(event.senderFrame.url).pathname;
			if (win !== liveReader() || (pathname !== "/reader" && pathname !== "/reader/")) throw new Error("This control belongs to the floating reader.");
		}
		return win;
	}
	function handle(channel, readerOnly, action) {
		ipcMain.handle(channel, async (event, ...args) => {
			authorized(event, readerOnly);
			return action(...args);
		});
		handlers.push(channel);
	}
	async function open() {
		let win = liveReader();
		if (!win) {
			win = createReaderWindow(new URL("/reader", origin).href);
			reader = win;
			win.setAlwaysOnTop(preferences.pinned);
			win.setOpacity(preferences.opacity);
			win.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
				if (mainFrame && !inPlace) speech.reset();
			});
			win.webContents.on("render-process-gone", () => speech.reset());
			win.webContents.once("destroyed", () => speech.reset());
			win.on("close", event => {
				// Hiding retains the document and lets server-owned study turns finish.
				if (!quitting) { event.preventDefault(); win.hide(); }
			});
			win.once("closed", () => { speech.reset(); if (reader === win) reader = null; });
			// createWindow shows the new window only after its first rendered frame.
			return;
		}
		if (win.isMinimized()) win.restore();
		win.show();
		win.focus();
	}
	async function toggle() {
		const win = liveReader();
		if (win?.isVisible() && !win.isMinimized()) win.hide();
		else await open();
	}
	async function openSession(id) {
		const target = new URL(`/chat/${encodeURIComponent(validateSessionId(id))}`, origin).href;
		const win = getMainWindow() ?? createMainWindow();
		if (win.webContents.getURL() !== target) await win.loadURL(target);
		if (win.isMinimized()) win.restore();
		win.show();
		win.focus();
	}
	function beforeQuit() {
		quitting = true;
		speech.dispose();
		persist();
		if (shortcutAvailable) globalShortcut.unregister(OVERLAY_SHORTCUT);
	}

	handle("lh:overlay:open", false, open);
	handle("lh:overlay:state", false, state);
	handle("lh:overlay:opacity", true, value => {
		preferences.opacity = normalizeOpacity(value);
		liveReader().setOpacity(preferences.opacity);
		schedulePersist();
		return preferences.opacity;
	});
	handle("lh:overlay:pin", true, value => {
		if (typeof value !== "boolean") throw new Error("Pinned must be true or false.");
		preferences.pinned = value;
		liveReader().setAlwaysOnTop(value);
		schedulePersist();
		return value;
	});
	handle("lh:overlay:hide", true, () => { liveReader().hide(); });
	handle("lh:overlay:pdf", true, async () => {
		const result = await dialog.showOpenDialog(liveReader(), {
			title: "Open a PDF in the floating reader", properties: ["openFile"], filters: [{ name: "PDF documents", extensions: ["pdf"] }],
		});
		return result.canceled || !result.filePaths[0] ? null : readPdf(result.filePaths[0]);
	});
	handle("lh:overlay:session", false, openSession);
	handle("lh:overlay:speech", true, command => {
		if (!command || typeof command !== "object") throw new Error("Invalid speech control.");
		if (command.op === "speak") return speech.speak(command);
		if (["voices", "pause", "resume", "stop", "state"].includes(command.op)) return speech[command.op]();
		throw new Error("Invalid speech control.");
	});
	try {
		shortcutAvailable = !globalShortcut.isRegistered(OVERLAY_SHORTCUT) && globalShortcut.register(OVERLAY_SHORTCUT, () => {
			void toggle().catch(error => log(`reader shortcut: ${error?.message ?? error}`));
		});
	} catch { shortcutAvailable = false; }
	app.on("before-quit", beforeQuit);

	return {
		open, toggle, state,
		dispose() {
			beforeQuit();
			app.removeListener("before-quit", beforeQuit);
			for (const channel of handlers) ipcMain.removeHandler(channel);
		},
	};
}

module.exports = { createOverlayController, normalizeOpacity, validateSessionId, readPdf, MAX_PDF_BYTES, OVERLAY_SHORTCUT };
