import {
	MAX_READER_STUDIES,
	READER_STUDIES_KEY,
	parseReaderStudies,
	passageStudyInput,
	passageStudyPrompt,
	readerStudyState,
	slotsConfigured,
	type ModelsSettings,
	type PassageStudyInput,
	type ReaderStudyRecord,
} from "@/src/core";

type ReaderStorage = Pick<Storage, "getItem" | "setItem">;
interface ReaderStudyClientOptions {
	fetchImpl: typeof fetch;
	storage?: ReaderStorage;
	onChange?: () => void;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

async function json(response: Response): Promise<Record<string, unknown> | undefined> {
	try { return object(await response.json()); }
	catch { return undefined; }
}

function responseError(body: Record<string, unknown> | undefined, fallback: string): string {
	return typeof body?.error === "string" && body.error.trim()
		? body.error.slice(0, 1_000) : fallback;
}

/**
 * Creates a session and submits exactly one explicit input to the existing
 * background-turn API. No automatic retry: a lost response may still have
 * started a billed turn, so the saved session stays available for inspection.
 * Storage is only a local index; canonical conversations stay server-owned.
 */
export function createReaderStudyClient({ fetchImpl, storage, onChange }: ReaderStudyClientOptions) {
	let memory: ReaderStudyRecord[] = [];
	let storageHealthy = Boolean(storage);
	let refreshVersion = 0;

	function list(): ReaderStudyRecord[] {
		if (storageHealthy && storage) {
			try { memory = parseReaderStudies(storage.getItem(READER_STUDIES_KEY)); }
			catch { storageHealthy = false; }
		}
		return memory.map(record => ({ ...record }));
	}

	function commit(records: ReaderStudyRecord[]) {
		memory = records.slice(0, MAX_READER_STUDIES).map(record => ({ ...record }));
		if (storageHealthy && storage) {
			try {
				const encoded = JSON.stringify(memory);
				storage.setItem(READER_STUDIES_KEY, encoded);
				if (storage.getItem(READER_STUDIES_KEY) !== encoded) storageHealthy = false;
			} catch { storageHealthy = false; }
		}
		try { onChange?.(); } catch { /* A view callback must not alter admission. */ }
	}

	function update(id: string, changes: Partial<ReaderStudyRecord>) {
		commit(list().map(record => record.id === id ? { ...record, ...changes } : record));
	}

	async function start(raw: PassageStudyInput): Promise<{ id: string; title: string }> {
		const input = passageStudyInput(raw);
		const prompt = passageStudyPrompt(input);
		let settingsResponse: Response;
		try { settingsResponse = await fetchImpl("/api/settings", { signal: AbortSignal.timeout(15_000) }); }
		catch { throw new Error("Could not check model setup. Keep the reader open and try again when the app is connected."); }
		const settingsBody = await json(settingsResponse);
		if (!settingsResponse.ok) throw new Error(responseError(settingsBody, "Could not check model setup."));
		const settings = object(settingsBody?.settings);
		if (!slotsConfigured(settings?.models as ModelsSettings | undefined)) {
			throw new Error("Configure the strong, cheap, and vision models in Settings before starting a study session.");
		}

		const requestedTitle = `${input.mode === "practice" ? "Practice" : "Study"}: ${input.documentName} · p. ${input.page}`;
		let createdResponse: Response;
		try {
			createdResponse = await fetchImpl("/api/chats", {
				method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: requestedTitle, ...(input.mode === "practice" ? { kind: "practice" } : {}) }),
				signal: AbortSignal.timeout(15_000),
			});
		} catch { throw new Error("Could not confirm session creation. Check the session list before starting again."); }
		const created = await json(createdResponse);
		if (!createdResponse.ok) throw new Error(responseError(created, "The study session could not be created."));
		if (typeof created?.id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(created.id)) {
			throw new Error("The app returned an invalid session. Check the session list before starting again.");
		}
		const id = created.id;
		const title = typeof created.title === "string" && created.title.trim()
			? created.title.slice(0, 500) : requestedTitle;
		commit([{
			id, title, documentName: input.documentName, page: input.page,
			quote: input.text.slice(0, 300), mode: input.mode,
			createdAt: new Date().toISOString(), state: "starting",
		}, ...list().filter(record => record.id !== id)]);

		let admitted: Response;
		try {
			admitted = await fetchImpl("/api/chat", {
				method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId: id, input: { type: "text", text: prompt } }),
				signal: AbortSignal.timeout(30_000),
			});
		} catch {
			const error = "Could not confirm whether the study started. Open this session before retrying; it may already be working.";
			update(id, { state: "error", error });
			throw new Error(error);
		}
		const admission = await json(admitted);
		if (!admitted.ok || admission?.ok !== true) {
			const error = responseError(admission, "The session did not confirm study admission. Open it to check before retrying.");
			update(id, { state: "error", error });
			throw new Error(error);
		}
		update(id, { state: "working", error: undefined });
		return { id, title };
	}

	async function refresh(): Promise<ReaderStudyRecord[]> {
		const version = ++refreshVersion;
		// A passage may be submitted while this snapshot is in flight. An old
		// list response cannot prove that a newly indexed session was deleted.
		const requestedIds = new Set(list().map(record => record.id));
		const response = await fetchImpl("/api/chats", { signal: AbortSignal.timeout(15_000) });
		const body = await json(response);
		if (!response.ok || !Array.isArray(body?.chats)) throw new Error(responseError(body, "Could not refresh study sessions."));
		if (version !== refreshVersion) return list();
		const byId = new Map(body.chats.flatMap((value: unknown) => {
			const chat = object(value);
			return typeof chat?.id === "string" ? [[chat.id, chat] as const] : [];
		}));
		commit(list().map<ReaderStudyRecord>(record => {
			const chat = byId.get(record.id);
			if (!chat) return requestedIds.has(record.id)
				? { ...record, state: "error", error: "This session no longer exists." } : record;
			const state = readerStudyState({
				busy: chat.busy === true, compacting: chat.compacting === true,
				pendingQuestion: chat.pendingQuestion === true, pendingProblem: chat.pendingProblem === true,
			});
			const title = typeof chat.title === "string" ? chat.title.slice(0, 500) : record.title;
			if (record.state === "error" && state === "ready") return { ...record, title };
			return { ...record, title, state, error: undefined };
		}));
		return list();
	}

	return { start, list, refresh };
}

export type ReaderStudyClient = ReturnType<typeof createReaderStudyClient>;
