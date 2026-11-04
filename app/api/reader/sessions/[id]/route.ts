import { readerStore } from "@/src/server";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
	try { return Response.json({ session: readerStore.get((await context.params).id) }); }
	catch { return Response.json({ error: "Reading session could not be opened." }, { status: 404 }); }
}
export async function PATCH(request: Request, context: Context) {
	try { return Response.json({ session: readerStore.patch((await context.params).id, await request.json()) }); }
	catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not save progress." }, { status: 400 }); }
}
