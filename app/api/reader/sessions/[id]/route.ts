import { readerStore, readerSessionFingerprint, ReaderSessionConflictError } from "@/src/server";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
	try { const session = readerStore.get((await context.params).id); return Response.json({ session, fingerprint: readerSessionFingerprint(session) }); }
	catch { return Response.json({ error: "Reading session could not be opened." }, { status: 404 }); }
}
export async function PATCH(request: Request, context: Context) {
	try {
		const body = await request.json();
		if (body.expectedFingerprint !== undefined && (typeof body.expectedFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedFingerprint))) throw new Error("Invalid reading-session fingerprint.");
		const session = readerStore.patch((await context.params).id, body, body.expectedFingerprint);
		return Response.json({ session, fingerprint: readerSessionFingerprint(session) });
	} catch (error) {
		if (error instanceof ReaderSessionConflictError) return Response.json({ error: error.message, session: error.session, fingerprint: readerSessionFingerprint(error.session) }, { status: 409 });
		return Response.json({ error: error instanceof Error ? error.message : "Could not save progress." }, { status: 400 });
	}
}
