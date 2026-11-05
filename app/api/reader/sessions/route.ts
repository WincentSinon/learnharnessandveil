import { readerStore, readerSessionFingerprint, readReaderSessionUpload, ReaderUploadError } from "@/src/server";
export const runtime = "nodejs";
export async function GET() { return Response.json({ sessions: readerStore.list() }); }
export async function POST(request: Request) {
	try {
		const { file, state } = await readReaderSessionUpload(request);
		const session = readerStore.create(file.name, new Uint8Array(await file.arrayBuffer()), state);
		return Response.json({ session, fingerprint: readerSessionFingerprint(session) }, { status: 201 });
	} catch (error) {
		if (error instanceof ReaderUploadError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
		if (error instanceof Error && !("code" in error)) return Response.json({ error: error.message, code: "reader_session_invalid" }, { status: 400 });
		return Response.json({ error: "The reading session could not be saved to local storage. Please try again.", code: "reader_storage_error" }, { status: 500 });
	}
}
