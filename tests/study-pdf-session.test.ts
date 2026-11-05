import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "veil-study-pdf-session-"));
process.env.LH_DATA_DIR = directory;
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
process.env.OPENROUTER_API_KEY = "fixture-only";
const { chatStore } = await import("../src/store/chats.ts");
const { readerStore } = await import("../src/store/reader-sessions.ts");
const { readerStudyStore } = await import("../src/store/reader-studies.ts");
const { createPracticeAgent, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");

after(() => {
	const absolute = path.resolve(directory);
	if (path.dirname(absolute) === path.resolve(os.tmpdir()) && path.basename(absolute).startsWith("veil-study-pdf-session-")) rmSync(absolute, { recursive: true, force: true });
});

function post(chatId: string, text: string) {
	return new Request("http://test/api/chat", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input: { type: "text", text } }),
	});
}

test("an attached passage can read another page through the real session turn", async () => {
	const pdf = tinyPdf([
		{ runs: [{ text: "The anchor is on page one.", x: 50, y: 700, size: 14 }] },
		{ runs: [{ text: "The lab requires three screenshots.", x: 50, y: 700, size: 14 }] },
	]);
	const session = readerStore.create("Study fixture.pdf", pdf, {
		pageCount: 2, page: 1, scrollFraction: 0, scale: 1, fit: true, voice: "", rate: 0,
		chapter: { start: 1, end: 2 }, drafts: {}, language: "en",
	});
	const chat = chatStore.createChat("PDF study", "practice");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	readerStudyStore.merge([{
		id: chat.id, title: chat.title, documentName: session.documentName, page: 1, quote: "anchor",
		mode: "practice", state: "ready", createdAt: new Date().toISOString(), documentId: session.documentId,
	}]);
	const faux = createFauxCore({});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("study_pdf", { action: "read", pages: "2" }, { id: "read-page-two" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Page 2 requires three screenshots.")]),
	]);
	const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const response = await handleChatRequest(post(chat.id, "What evidence does the lab ask for?"), opts => {
		assert.equal(opts.studyPdfTool?.name, "study_pdf");
		return createPracticeAgent({ chatId: chat.id, chatStore }, { ...opts, engine });
	});
	assert.equal(response.status, 200, await response.text());
	const run = runningTurn(chat.id);
	if (run) await new Response(run.subscribe()).text();
	const result = chatStore.getChat(chat.id)?.messages.find(message => message.role === "toolResult" && message.toolName === "study_pdf");
	assert.match(JSON.stringify(result), /three screenshots/);
	assert.match(JSON.stringify(result), /[Pp]age.{0,6}2/);
});

test("an unrelated session receives no attached-PDF tool", async () => {
	const chat = chatStore.createChat("Unrelated conversation");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage([fauxText("No document attached.")])]);
	const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const response = await handleChatRequest(post(chat.id, "Can you use study_pdf?"), opts => {
		assert.equal(opts.studyPdfTool, undefined);
		return createTeacherAgent(undefined, { ...opts, engine });
	});
	assert.equal(response.status, 200, await response.text());
	const run = runningTurn(chat.id);
	if (run) await new Response(run.subscribe()).text();
});
