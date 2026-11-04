import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MAX_READER_PDF_BYTES, MAX_READER_STATE_BYTES, MAX_READER_BODY_BYTES, MAX_DESKTOP_PROXY_BODY_BYTES,
} from "../lib/reader-upload-limits.ts";
import { readReaderSessionUpload, ReaderUploadError } from "../src/server/reader-session-upload.ts";
import { MAX_IMPORT_BYTES, MAX_IMPORT_BODY_BYTES } from "../lib/notes-import-limits.ts";
import nextConfig from "../next.config.ts";

const limits = { fileBytes: 128, stateBytes: 512, bodyBytes: 2048 };
const url = "http://localhost/api/reader/sessions";
function pdfBytes(length = 32) {
	const bytes = new Uint8Array(length); bytes.fill(32);
	bytes.set(new TextEncoder().encode("%PDF-1.7\n")); return bytes;
}
function upload(options: { bytes?: Uint8Array; filename?: string; type?: string; state?: string; file?: boolean; stateField?: boolean; duplicateFile?: boolean; duplicateState?: boolean } = {}) {
	const form = new FormData();
	const file = new File([new Uint8Array(options.bytes ?? pdfBytes())], options.filename ?? "example.pdf", { type: options.type ?? "application/pdf" });
	if (options.file !== false) form.append("file", file);
	if (options.stateField !== false) form.append("state", options.state ?? JSON.stringify({ pageCount: 2, page: 1 }));
	if (options.duplicateFile) form.append("file", file);
	if (options.duplicateState) form.append("state", "{}");
	return new Request(url, { method: "POST", body: form });
}
async function rejectsUpload(request: Request, status: number, override = limits) {
	await assert.rejects(readReaderSessionUpload(request, override), (error: unknown) => {
		assert.ok(error instanceof ReaderUploadError);
		assert.equal(error.status, status);
		assert.equal(typeof error.code, "string"); assert.ok(error.code.length > 0);
		assert.ok(error.message.length > 0);
		assert.doesNotMatch(error.message, /Failed to parse body as FormData|TypeError:|\bat .*\.ts:\d+/);
		return true;
	});
}

test("reader upload and shared proxy limits leave room for state and multipart framing", () => {
	assert.equal(MAX_READER_PDF_BYTES, 100 * 1024 * 1024);
	assert.equal(MAX_READER_STATE_BYTES, 8 * 1024 * 1024);
	assert.ok(MAX_READER_BODY_BYTES > MAX_READER_PDF_BYTES + MAX_READER_STATE_BYTES);
	assert.ok(MAX_DESKTOP_PROXY_BODY_BYTES > MAX_READER_BODY_BYTES, "the route must reject oversize streams before proxy truncation");
	assert.equal(nextConfig.experimental?.proxyClientMaxBodySize, MAX_DESKTOP_PROXY_BODY_BYTES);
	assert.equal(MAX_IMPORT_BYTES, 25 * 1024 * 1024, "notes imports retain their independent file limit");
	assert.equal(MAX_IMPORT_BODY_BYTES, 26 * 1024 * 1024, "notes multipart reads retain their independent body limit");
});

test("a complete multipart upload retains PDF bytes and parses JSON state at exact file/state limits", async () => {
	const emptyStateBytes = Buffer.byteLength(JSON.stringify({ draft: "" }), "utf8");
	const state = JSON.stringify({ draft: "x".repeat(limits.stateBytes - emptyStateBytes) });
	assert.equal(Buffer.byteLength(state, "utf8"), limits.stateBytes);
	const input = pdfBytes(limits.fileBytes);
	const result = await readReaderSessionUpload(upload({ bytes: input, state }), limits);
	assert.equal(result.file.size, limits.fileBytes);
	assert.deepEqual(new Uint8Array(await result.file.arrayBuffer()), input);
	assert.deepEqual(result.state, JSON.parse(state));
});

test("ordinary PDF MIME variants and uppercase extension are accepted", async () => {
	for (const type of ["application/pdf", "application/octet-stream", ""]) {
		const result = await readReaderSessionUpload(upload({ filename: "example.PDF", type }), limits);
		assert.equal(result.file.name, "example.PDF");
	}
});

test("declared oversize bodies are refused before reading their stream", async () => {
	let reads = 0, cancelled = false;
	const body = new ReadableStream<Uint8Array>({ pull() { reads++; }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
	const request = new Request(url, { method: "POST", body, duplex: "half", headers: { "content-type": "multipart/form-data; boundary=test", "content-length": String(limits.bodyBytes + 1) } } as RequestInit);
	await rejectsUpload(request, 413);
	assert.equal(reads, 0); assert.equal(cancelled, true);
});

for (const declared of [undefined, "1"]) test(`actual streamed bytes are bounded with ${declared ? "a misleading" : "no"} Content-Length`, async () => {
	let chunks = 0, cancelled = false;
	const body = new ReadableStream<Uint8Array>({ pull(controller) { chunks++; controller.enqueue(new Uint8Array(256)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
	const request = new Request(url, { method: "POST", body, duplex: "half", headers: { "content-type": "multipart/form-data; boundary=test", ...(declared ? { "content-length": declared } : {}) } } as RequestInit);
	await rejectsUpload(request, 413);
	assert.equal(chunks, limits.bodyBytes / 256 + 1); assert.equal(cancelled, true);
});

test("the exact total-body limit is accepted and one byte less is refused", async () => {
	const request = upload(); const bytes = new Uint8Array(await request.arrayBuffer());
	const make = () => new Request(url, { method: "POST", body: bytes, headers: request.headers });
	assert.ok((await readReaderSessionUpload(make(), { ...limits, bodyBytes: bytes.length })).file.size > 0);
	await rejectsUpload(make(), 413, { ...limits, bodyBytes: bytes.length - 1 });
});

test("file and UTF-8 state sizes are independently bounded before persistence", async () => {
	await rejectsUpload(upload({ bytes: pdfBytes(limits.fileBytes + 1) }), 413);
	const state = JSON.stringify({ draft: "å".repeat(257) });
	assert.ok(state.length < limits.stateBytes && Buffer.byteLength(state, "utf8") > limits.stateBytes);
	await rejectsUpload(upload({ state }), 413);
});

test("truncated multipart, missing boundaries, invalid JSON and absent bodies return safe errors", async () => {
	const complete = upload(); const bytes = new Uint8Array(await complete.arrayBuffer());
	for (const request of [
		new Request(url, { method: "POST", body: bytes.slice(0, -30), headers: complete.headers }),
		new Request(url, { method: "POST", body: "not multipart", headers: { "content-type": "multipart/form-data" } }),
		new Request(url, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }),
		new Request(url, { method: "POST" }),
		upload({ state: "not-json" }),
	]) await rejectsUpload(request, 400);
});

test("non-PDF files, invalid signatures and missing or duplicate fields are refused", async () => {
	const form = new FormData(); form.set("file", "not a file"); form.set("state", "{}");
	for (const request of [
		upload({ filename: "example.txt" }), upload({ type: "text/plain" }),
		upload({ bytes: new TextEncoder().encode("Not a PDF document.") }),
		upload({ file: false }), upload({ stateField: false }),
		upload({ duplicateFile: true }), upload({ duplicateState: true }),
		new Request(url, { method: "POST", body: form }),
	]) await rejectsUpload(request, 400);
});
