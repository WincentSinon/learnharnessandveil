import { readerStore } from "@/src/server";
export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
	try { return new Response(readerStore.pdf((await context.params).id), { headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store" } }); }
	catch { return Response.json({ error: "Saved PDF could not be opened." }, { status: 404 }); }
}
