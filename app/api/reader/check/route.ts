import { readReaderAttempt, startReaderCheck } from "@/src/server";
export const runtime = "nodejs";
export async function POST(request: Request) {
	try { return Response.json({ attempt: await startReaderCheck(await request.json()) }, { status: 202 }); }
	catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not start understanding check." }, { status: 400 }); }
}
export async function GET(request: Request) {
	try { const url = new URL(request.url); return Response.json({ attempt: readReaderAttempt(url.searchParams.get("sessionId") || "", url.searchParams.get("id") || "") }); }
	catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Check could not be found." }, { status: 404 }); }
}
