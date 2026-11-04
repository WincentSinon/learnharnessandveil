import { MAX_READER_BODY_BYTES, MAX_READER_PDF_BYTES, MAX_READER_STATE_BYTES } from "../../lib/reader-upload-limits.ts";

export class ReaderUploadError extends Error {
	constructor(message: string, readonly status: 400 | 413, readonly code: string) { super(message); this.name = "ReaderUploadError"; }
}
interface UploadLimits { fileBytes: number; stateBytes: number; bodyBytes: number }
const tooLarge = () => new ReaderUploadError("This reading-session upload is too large. Choose a PDF up to 100 MB and try again.", 413, "reader_upload_too_large");
const incomplete = () => new ReaderUploadError("The PDF upload was incomplete or could not be read. Your explanation is still here; please try saving again.", 400, "reader_upload_incomplete");

/** Bound the actual stream before parsing; Content-Length is only an early check. */
export async function readReaderSessionUpload(request: Request, limits: UploadLimits = { fileBytes: MAX_READER_PDF_BYTES, stateBytes: MAX_READER_STATE_BYTES, bodyBytes: MAX_READER_BODY_BYTES }): Promise<{ file: File; state: unknown }> {
	if (Number(request.headers.get("content-length")) > limits.bodyBytes) {
		void request.body?.cancel().catch(() => {}); throw tooLarge();
	}
	const contentType = request.headers.get("content-type") || "";
	if (!/^multipart\/form-data\b/i.test(contentType)) { void request.body?.cancel().catch(() => {}); throw incomplete(); }
	const reader = request.body?.getReader(); if (!reader) throw incomplete();
	let form: FormData;
	try {
		const chunks: Uint8Array[] = []; let length = 0;
		for (;;) {
			const chunk = await reader.read(); if (chunk.done) break;
			length += chunk.value.byteLength; if (length > limits.bodyBytes) throw tooLarge();
			chunks.push(chunk.value);
		}
		const bytes = new Uint8Array(length); let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
		form = await new Response(bytes, { headers: { "Content-Type": contentType } }).formData();
	} catch (error) { if (error instanceof ReaderUploadError) throw error; throw incomplete(); }
	finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
	if (form.getAll("file").length !== 1 || form.getAll("state").length !== 1) throw new ReaderUploadError("Choose one PDF and include its reading-session details.", 400, "reader_upload_invalid");
	const file = form.get("file"), metadata = form.get("state");
	if (!(file instanceof File) || !/\.pdf$/i.test(file.name) || !["", "application/pdf", "application/octet-stream"].includes(file.type)) throw new ReaderUploadError("Choose a PDF file.", 400, "reader_upload_invalid");
	if (!file.size || file.size > limits.fileBytes) throw tooLarge();
	if (!Buffer.from(await file.slice(0, 1024).arrayBuffer()).includes(Buffer.from("%PDF-"))) throw new ReaderUploadError("This file is not a valid PDF.", 400, "reader_upload_invalid");
	if (typeof metadata !== "string") throw new ReaderUploadError("Reading-session details are missing.", 400, "reader_upload_invalid");
	if (Buffer.byteLength(metadata, "utf8") > limits.stateBytes) throw tooLarge();
	try { return { file, state: JSON.parse(metadata) }; }
	catch { throw new ReaderUploadError("Reading-session details could not be read. Please try saving again.", 400, "reader_upload_invalid"); }
}
