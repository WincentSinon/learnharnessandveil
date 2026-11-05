import { PATHS } from "../../config.ts";
import { readerStore, readerSessionFingerprint, ReaderSessionConflictError } from "../store/reader-sessions.ts";
import { preserveSyncConflict } from "./cloud-sync-data.ts";
import { desktopAPIAuthorized } from "./desktop-access.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";
import { readBoundedJson } from "./custom-provider-body.ts";

/** Preserve the server's version before a reader merges simultaneous draft edits. */
export function preserveReaderCloudConflict(id: string, expectedFingerprint: string) {
	const session = readerStore.get(id);
	if (readerSessionFingerprint(session) !== expectedFingerprint) throw new ReaderSessionConflictError(session);
	const copy = preserveSyncConflict(PATHS.data, { key: `reader-session/${id}`, kind: "reader-session", payload: session as unknown as Record<string, unknown> }, "reader draft");
	return readerStore.get(String(copy.payload.id));
}

export async function readerCloudConflictResponse(request: Request, id: string): Promise<Response> {
	const desktop = process.env.LH_DESKTOP_SERVER === "1" || Boolean(process.env.LH_DESKTOP_API_SECRET);
	const allowed = desktop ? desktopAPIAuthorized(request.headers) : request.headers.get("origin") === subscriptionRequestOrigin(request)
		&& request.headers.get("origin") !== null && (!request.headers.has("sec-fetch-site") || request.headers.get("sec-fetch-site") === "same-origin");
	if (!allowed) return Response.json({ error: "Open this reading session in the app to preserve a draft." }, { status: 403 });
	try {
		const body = await readBoundedJson(request, 2048) as { expectedFingerprint?: unknown };
		if (typeof body.expectedFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedFingerprint)) throw new Error("A current reading-session fingerprint is required.");
		const session = preserveReaderCloudConflict(id, body.expectedFingerprint);
		return Response.json({ session, fingerprint: readerSessionFingerprint(session) });
	} catch (failure) {
		if (failure instanceof ReaderSessionConflictError) return Response.json({ error: failure.message, session: failure.session, fingerprint: readerSessionFingerprint(failure.session) }, { status: 409 });
		return Response.json({ error: failure instanceof Error ? failure.message : "The alternate draft could not be preserved." }, { status: 400 });
	}
}
