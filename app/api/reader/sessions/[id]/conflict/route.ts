import { readerCloudConflictResponse } from "@/src/server";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
	return readerCloudConflictResponse(request, (await context.params).id);
}
