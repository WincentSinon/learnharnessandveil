import { readerStore } from "@/src/server";
export const runtime = "nodejs";
export async function GET() { return Response.json({ sessions: readerStore.list() }); }
export async function POST(request: Request) {
	try {
		const form = await request.formData(); const file = form.get("file");
		if (!(file instanceof File) || file.size > 100 * 1024 * 1024) throw new Error("Choose a PDF smaller than 100 MB.");
		const state = JSON.parse(String(form.get("state")));
		return Response.json({ session: readerStore.create(file.name, new Uint8Array(await file.arrayBuffer()), state) }, { status: 201 });
	} catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not save reading session." }, { status: 400 }); }
}
