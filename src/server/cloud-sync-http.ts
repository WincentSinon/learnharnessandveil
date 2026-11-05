import { getCloudSyncStatus, cloudSyncAction } from "./cloud-sync.ts";
import { CloudSyncError } from "./cloud-supabase.ts";
import { desktopAPIAuthorized } from "./desktop-access.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";
import { readBoundedJson, CustomBodyLimitError } from "./custom-provider-body.ts";
import { CLOUD_SYNC_SQL } from "./cloud-sync-schema.ts";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
export async function cloudSyncResponse(request: Request): Promise<Response> {
	if (request.method === "GET") return Response.json(await getCloudSyncStatus(), { headers });
	if (request.method !== "POST") return Response.json({ error: "Unsupported cloud sync method." }, { status: 405, headers });
	const desktop = process.env.LH_DESKTOP_SERVER === "1" || Boolean(process.env.LH_DESKTOP_API_SECRET);
	const allowed = desktop ? desktopAPIAuthorized(request.headers) : request.headers.get("origin") === subscriptionRequestOrigin(request)
		&& request.headers.get("origin") !== null && (!request.headers.has("sec-fetch-site") || request.headers.get("sec-fetch-site") === "same-origin");
	if (!allowed) return Response.json({ error: "Open Cloud sync settings from the app to make changes." }, { status: 403, headers });
	if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return Response.json({ error: "Cloud settings require a JSON request." }, { status: 415, headers });
	try {
		const body = await readBoundedJson(request, 16 * 1024);
		return Response.json(await cloudSyncAction(body), { headers });
	} catch (failure) {
		const message = failure instanceof Error ? failure.message : "Cloud sync could not complete. Your local saves are unchanged.";
		const status = failure instanceof CustomBodyLimitError ? 413 : failure instanceof CloudSyncError ? Math.max(400, Math.min(599, failure.status || 400)) : 400;
		return Response.json({ error: message, status: await getCloudSyncStatus() }, { status, headers });
	}
}

export function cloudSyncSetupResponse(): Response {
	return new Response(CLOUD_SYNC_SQL, { headers: { ...headers, "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": "inline; filename=veil-cloud-sync.sql" } });
}
