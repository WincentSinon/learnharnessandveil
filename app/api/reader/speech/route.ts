import { installNeuralVoices, neuralStatus, synthesizeNeural } from "@/src/server";
export const runtime = "nodejs";
export async function GET() { return Response.json(neuralStatus()); }
export async function POST(request: Request) {
	try {
		const input = await request.json();
		if (input.op === "install") { void installNeuralVoices().catch(() => {}); return Response.json(neuralStatus(), { status: 202 }); }
		return new Response(new Uint8Array(await synthesizeNeural(input, request.signal)), { headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" } });
	} catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Local speech failed." }, { status: 400 }); }
}
