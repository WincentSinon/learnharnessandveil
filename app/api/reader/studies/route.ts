import { readerStudyStore } from "@/src/server";

export async function GET() { return Response.json({ records: readerStudyStore.list() }); }

export async function POST(request: Request) {
	try {
		const text = await request.text(); if (text.length > 250_000) throw new Error("Passage links are too large.");
		const body = JSON.parse(text) as { records?: unknown };
		return Response.json({ records: readerStudyStore.merge(body.records) });
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Passage links could not be saved." }, { status: 400 });
	}
}
