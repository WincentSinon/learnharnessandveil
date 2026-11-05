"use client";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { BookMarkedIcon, CheckCheckIcon, SaveIcon, XIcon } from "lucide-react";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import type { ReaderChapter, ReaderAttempt, ReaderSession, ReaderSessionState, ReaderSessionSummary } from "@/src/core";
import { readingState, reconcileReaderCloud } from "@/src/core";
import styles from "./reader-workspace.module.css";
import { CloudSyncIndicator } from "./cloud-sync-status";
import { useServerEvent } from "./server-events";

export interface ReadingDocument { name: string; data: Uint8Array }
export interface ReaderWorkspaceHandle { getStudyDocument: () => Promise<ReaderSession> }
export interface ReaderWorkspaceProps {
	ref?: Ref<ReaderWorkspaceHandle>;
	documentName: string; documentVersion: number; page: number; pageCount: number; loading: boolean;
	getFile: () => ReadingDocument | null;
	getState: () => Omit<ReaderSessionState, "chapter" | "drafts" | "language">;
	getChapters: () => Promise<ReaderChapter[]>;
	extract: (start: number, end: number) => Promise<Array<{ page: number; text: string }>>;
	restore: (file: ReadingDocument, session: ReaderSession) => Promise<void>;
	pause: () => void;
}
async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init); const body = await response.json();
	if (response.status === 409) throw new ReaderWriteConflict();
	if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "The action could not be completed.");
	return body;
}
class ReaderWriteConflict extends Error { constructor() { super("Reading progress changed. Refreshing before saving."); } }
type SessionResponse = { session: ReaderSession; fingerprint?: string };
const jsonBody = (value: unknown) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });

export function ReaderWorkspace(props: ReaderWorkspaceProps) {
	const [panel, setPanel] = useState<"library" | "check" | null>(null);
	const [library, setLibrary] = useState<ReaderSessionSummary[]>([]);
	const [session, setSession] = useState<ReaderSession | null>(null);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [chapter, setChapter] = useState<ReaderChapter>({ start: 1, end: 1 });
	const [chapters, setChapters] = useState<ReaderChapter[]>([]);
	const [language, setLanguage] = useState<"en" | "sv">("en");
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const [saving, setSaving] = useState(false);
	const [checking, setChecking] = useState(false);
	const [attempts, setAttempts] = useState<ReaderAttempt[]>([]);
	const [restoring, setRestoring] = useState(false);
	const { open: openSettings } = useSettingsDialog();
	const current = useRef({ props, session, drafts, chapter, language }); current.current = { props, session, drafts, chapter, language };
	const epoch = useRef(0), restoringRef = useRef(false), saved = useRef("");
	const patchChain = useRef(Promise.resolve());
	const savedFile = useRef<ReadingDocument | null>(null);
	const creating = useRef<{ file: ReadingDocument; task: Promise<ReaderSession | null> } | null>(null);
	const checkedRequest = useRef<string | null>(null);
	const checkingAdmission = useRef(false);
	const acknowledged = useRef<ReaderSessionState | null>(null);
	const fingerprint = useRef<string | undefined>(undefined);
	const cloudRefreshing = useRef(false), cloudAgain = useRef(false);
	const cloudTask = useRef<Promise<void> | null>(null);
	const refreshActive = useRef<() => Promise<void>>(() => Promise.resolve());
	const ignoreDocumentReset = useRef(false);
	const panelElement = useRef<HTMLElement>(null);
	const snapshot = useCallback((): ReaderSessionState => {
		const value = current.current;
		return { ...value.props.getState(), chapter: value.chapter, drafts: value.drafts, language: value.language };
	}, []);
	const refreshLibrary = useCallback(() => jsonRequest<{ sessions: ReaderSessionSummary[] }>("/api/reader/sessions").then(value => setLibrary(value.sessions)), []);
	useServerEvent("cloud-sync-changed", () => { void refreshLibrary().catch(() => {}); void refreshActive.current(); });
	const persist = useCallback(() => {
		const owner = current.current.session;
		if (!owner || savedFile.current !== current.current.props.getFile() || current.current.props.loading || restoringRef.current || cloudRefreshing.current) return;
		const value = snapshot(), encoded = JSON.stringify(value);
		if (saved.current === encoded) return;
		saved.current = encoded;
		setMessage("Saving progress…");
		patchChain.current = patchChain.current.catch(() => {}).then(async () => {
			if (cloudRefreshing.current || current.current.session?.id !== owner.id) { if (current.current.session?.id === owner.id) saved.current = ""; return; }
			try {
				const result = await jsonRequest<SessionResponse>(`/api/reader/sessions/${owner.id}`, { method: "PATCH", ...jsonBody({ ...value, expectedFingerprint: fingerprint.current }) });
				if (current.current.session?.id === owner.id) {
					fingerprint.current = result.fingerprint; acknowledged.current = readingState(result.session);
					current.current.session = result.session; setSession(result.session); setAttempts(result.session.attempts);
					setChecking(checkingAdmission.current || result.session.attempts.some(attempt => attempt.status === "pending")); setMessage("Progress saved locally");
					window.dispatchEvent(new Event("veil:study-saved"));
				}
			} catch (failure) {
				if (current.current.session?.id === owner.id) {
					saved.current = "";
					if (failure instanceof ReaderWriteConflict) queueMicrotask(() => { void refreshActive.current(); });
					else setError(failure instanceof Error ? failure.message : "Progress could not be saved.");
				}
			}
		});
	}, [snapshot]);
	refreshActive.current = () => {
		if (cloudTask.current) { cloudAgain.current = true; return cloudTask.current; }
		const owner = current.current.session;
		if (!owner || restoringRef.current || current.current.props.loading) return Promise.resolve();
		const version = epoch.current;
		cloudRefreshing.current = true;
		const alive = () => current.current.session?.id === owner.id && epoch.current === version && !restoringRef.current;
		const task = (async () => {
			await patchChain.current.catch(() => {});
			for (let retry = 0; retry < 3; retry++) {
				try {
					const result = await jsonRequest<SessionResponse>(`/api/reader/sessions/${owner.id}`);
					if (!alive()) return;
					const remote = readingState(result.session), base = acknowledged.current ?? remote;
					let latest = snapshot(), merged = reconcileReaderCloud(base, latest, remote);
					if (merged.conflicts.length) {
						await jsonRequest(`/api/reader/sessions/${owner.id}/conflict`, { method: "POST", ...jsonBody({ expectedFingerprint: result.fingerprint }) });
						if (!alive()) return;
						latest = snapshot(); merged = reconcileReaderCloud(base, latest, remote);
						void refreshLibrary().catch(() => {});
					}
					const dirty = merged.localChanges || saved.current !== JSON.stringify(latest);
					// Publish refs before React renders: typing or the one-second timer
					// must never dispatch a stale draft between the merge and the paint.
					current.current = { ...current.current, session: result.session, drafts: merged.state.drafts, chapter: merged.state.chapter, language: merged.state.language };
					fingerprint.current = result.fingerprint; acknowledged.current = remote;
					setSession(result.session); setDrafts(merged.state.drafts); setChapter(merged.state.chapter); setLanguage(merged.state.language); setAttempts(result.session.attempts);
					setChecking(checkingAdmission.current || result.session.attempts.some(attempt => attempt.status === "pending"));
					// Keeping the visible page is deliberate. A remote-only change must
					// not immediately autosave that older visible page back over it.
					saved.current = dirty ? "" : JSON.stringify(merged.state);
					setMessage(merged.conflicts.length ? "Both drafts preserved · alternate version in My reading" : dirty ? "Cloud changes merged · saving your draft" : "Cloud changes loaded · your current page stays open");
					return;
				} catch (failure) { if (!(failure instanceof ReaderWriteConflict) || retry === 2) throw failure; }
			}
		})().catch(failure => { if (alive()) setError(failure instanceof Error ? failure.message : "Could not refresh cloud reading progress."); })
			.finally(() => { cloudRefreshing.current = false; cloudTask.current = null; if (cloudAgain.current) { cloudAgain.current = false; queueMicrotask(() => { void refreshActive.current(); }); } });
		cloudTask.current = task; return task;
	};
	useEffect(() => {
		void refreshLibrary().catch(() => {});
		const timer = setInterval(persist, 1000);
		const closing = () => {
			const owner = current.current.session;
			const value = snapshot();
			if (owner && !restoringRef.current && !cloudRefreshing.current && saved.current !== JSON.stringify(value)) void fetch(`/api/reader/sessions/${owner.id}`, { method: "PATCH", ...jsonBody({ ...value, expectedFingerprint: fingerprint.current }), keepalive: true }).catch(() => {});
		};
		window.addEventListener("beforeunload", closing);
		return () => { clearInterval(timer); window.removeEventListener("beforeunload", closing); closing(); };
	}, [persist, refreshLibrary, snapshot]);
	useEffect(() => {
		if (ignoreDocumentReset.current) { ignoreDocumentReset.current = false; return; }
		if (restoringRef.current) return;
		epoch.current++; checkedRequest.current = null;
		setSession(null); setDrafts({}); setAttempts([]); setChecking(false); setError(""); setMessage("");
		setChapter({ start: props.page, end: Math.min(props.pageCount || 1, props.page + 4) });
		saved.current = ""; acknowledged.current = null; fingerprint.current = undefined; savedFile.current = null;
		if (props.pageCount) {
			const owner = epoch.current;
			void props.getChapters().then(value => { if (owner === epoch.current) setChapters(value); }).catch(() => setChapters([]));
		}
	// Only successful document changes reset the reading session.
	}, [props.documentVersion]);
	useEffect(() => { const timer = setTimeout(persist, 350); return () => clearTimeout(timer); }, [drafts, chapter, language, persist]);
	useEffect(() => { checkedRequest.current = null; }, [props.page, chapter, language]);
	useEffect(() => {
		if (!panel) return;
		const previousFocus = document.activeElement as HTMLElement | null;
		panelElement.current?.querySelector<HTMLElement>(panel === "check" ? "textarea" : "button")?.focus({ preventScroll: true });
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setPanel(null);
			if (event.key !== "Tab") return;
			const controls = [...(panelElement.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)') ?? [])];
			const first = controls[0], last = controls.at(-1);
			if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
			else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
		};
		window.addEventListener("keydown", escape); return () => { window.removeEventListener("keydown", escape); previousFocus?.focus({ preventScroll: true }); };
	}, [panel]);
	useEffect(() => {
		if (!session?.attempts.some(value => value.status === "pending")) return;
		let alive = true;
		const owner = session.id;
		const pending = session.attempts.filter(value => value.status === "pending");
		const timer = setInterval(() => { void Promise.all(pending.map(value => jsonRequest<{ attempt: ReaderAttempt }>(`/api/reader/check?sessionId=${owner}&id=${value.id}`))).then(values => {
			if (!alive || current.current.session?.id !== owner) return;
			setAttempts(previous => previous.map(attempt => values.find(value => value.attempt.id === attempt.id)?.attempt ?? attempt));
			if (values.every(value => value.attempt.status !== "pending")) { setSession(previous => previous?.id === owner ? { ...previous, attempts: previous.attempts.map(attempt => values.find(value => value.attempt.id === attempt.id)?.attempt ?? attempt) } : previous); setChecking(false); }
		}).catch(() => {}); }, 1000);
		return () => { alive = false; clearInterval(timer); };
	}, [session]);
	async function save(): Promise<ReaderSession | null> {
		const file = current.current.props.getFile();
		if (!file || current.current.props.loading || restoringRef.current) return null;
		if (current.current.session && savedFile.current === file) {
			setSaving(true);
			saved.current = "";
			try {
				for (let retry = 0; retry < 3; retry++) {
					if (cloudTask.current) await cloudTask.current;
					persist(); await patchChain.current;
					if (cloudTask.current) await cloudTask.current;
					if (saved.current === JSON.stringify(snapshot())) return current.current.session;
				}
				setError("Your draft is still open. Wait for cloud changes to finish, then save again."); return null;
			} finally { setSaving(false); }
		}
		if (creating.current?.file === file) return creating.current.task;
		const owner = epoch.current;
		setSaving(true);
		setError("");
		const task = (async () => {
			try {
				const state = snapshot();
				const form = new FormData();
				form.set("file", new Blob([new Uint8Array(file.data)], { type: "application/pdf" }), file.name);
				form.set("state", JSON.stringify(state));
				const value = await jsonRequest<SessionResponse>("/api/reader/sessions", { method: "POST", body: form });
				if (owner !== epoch.current || current.current.props.getFile() !== file) return null;
				savedFile.current = file;
				setSession(value.session);
				current.current.session = value.session;
				fingerprint.current = value.fingerprint;
				acknowledged.current = readingState(value.session);
				saved.current = JSON.stringify(state);
				setMessage("Reading session saved · autosave is on");
				window.dispatchEvent(new Event("veil:study-saved"));
				void refreshLibrary().catch(() => {});
				return value.session;
			} catch (failure) {
				if (owner === epoch.current) setError(failure instanceof Error ? failure.message : "Session could not be saved.");
				return null;
			}
		})();
		creating.current = { file, task };
		try { return await task; }
		finally {
			if (creating.current?.task === task) {
				creating.current = null;
				setSaving(false);
			}
		}
	}

	useImperativeHandle(props.ref, () => ({
		async getStudyDocument() {
			const file = current.current.props.getFile();
			if (!file || current.current.props.loading || restoringRef.current) throw new Error("Wait for the PDF to finish opening, then try again.");
			const existing = savedFile.current === file ? current.current.session : null;
			const document = existing ?? await save();
			if (current.current.props.getFile() !== file) throw new Error("The open PDF changed. Select the passage again.");
			if (!document) throw new Error("The PDF could not be saved in My reading. Try Save session, then start the study again.");
			return document;
		},
	}));
	async function resume(id: string) {
		if (cloudTask.current) await cloudTask.current;
		if (restoringRef.current) return;
		persist(); restoringRef.current = true; setRestoring(true); await patchChain.current;
		setError(""); epoch.current++; const owner = epoch.current;
		try {
			const value = await jsonRequest<SessionResponse>(`/api/reader/sessions/${id}`);
			const response = await fetch(`/api/reader/sessions/${id}/pdf`); if (!response.ok) throw new Error("The saved PDF could not be opened.");
			ignoreDocumentReset.current = true;
			const file = { name: value.session.documentName, data: new Uint8Array(await response.arrayBuffer()) };
			await props.restore(file, value.session);
			if (owner !== epoch.current) return;
			savedFile.current = file;
			setSession(value.session); current.current = { ...current.current, session: value.session, drafts: value.session.drafts, chapter: value.session.chapter, language: value.session.language }; setDrafts(value.session.drafts); setChapter(value.session.chapter); setLanguage(value.session.language); setAttempts(value.session.attempts);
			fingerprint.current = value.fingerprint; acknowledged.current = readingState(value.session);
			saved.current = JSON.stringify(snapshot()); checkedRequest.current = null; setChecking(value.session.attempts.some(attempt => attempt.status === "pending")); setMessage(`Resumed page ${value.session.page} · speech is stopped`); setPanel(null);
			setChapters(await props.getChapters());
		} catch (failure) { ignoreDocumentReset.current = false; setError(failure instanceof Error ? failure.message : "Reading session could not be opened."); }
		finally { restoringRef.current = false; setRestoring(false); }
	}
	function openCheck() {
		props.pause(); setPanel("check"); setError("");
		if (props.page < chapter.start || props.page > chapter.end) setChapter({ start: props.page, end: Math.min(props.pageCount, props.page + 4) });
	}
	function changeDraft(text: string) {
		checkedRequest.current = null;
		const next = { ...current.current.drafts, [String(current.current.props.page)]: text };
		current.current.drafts = next; setDrafts(next);
	}
	async function check() {
		if (checking) return;
		checkingAdmission.current = true;
		const owner = epoch.current, page = props.page, range = { ...chapter }, rephrase = drafts[String(page)] || "";
		setChecking(true); setError("");
		try {
			if (page < range.start || page > range.end || range.end - range.start >= 30) throw new Error("Include this page in a chapter range of up to 30 pages.");
			if (rephrase.trim().length < 10) throw new Error("Explain the page in your own words before checking.");
			const savedSession = await save(); if (!savedSession || owner !== epoch.current) { setChecking(false); return; }
			const chapterPages = await props.extract(range.start, range.end);
			if (owner !== epoch.current) return;
			const requestId = checkedRequest.current ??= crypto.randomUUID();
			const value = await jsonRequest<{ attempt: ReaderAttempt }>("/api/reader/check", { method: "POST", ...jsonBody({ sessionId: savedSession.id, requestId, page, chapter: range, chapterPages, pageText: chapterPages.find(value => value.page === page)?.text || "", rephrase, language }) });
			if (owner !== epoch.current) return;
			checkedRequest.current = null;
			setAttempts(previous => [...previous.filter(attempt => attempt.id !== value.attempt.id), value.attempt]);
			setSession(previous => previous ? { ...previous, attempts: [...previous.attempts.filter(attempt => attempt.id !== value.attempt.id), value.attempt] } : previous);
			setChecking(value.attempt.status === "pending");
		} catch (failure) { if (owner === epoch.current) { setError(failure instanceof Error ? failure.message : "The check could not start."); setChecking(false); } }
		finally { checkingAdmission.current = false; }
	}
	const pageAttempts = attempts.filter(attempt => attempt.page === props.page).toReversed();
	const modelSetupError = /^(Configure a strong model in Settings|Connect the selected AI provider in Settings)/.test(error);
	return <>
		<div className={styles.bar} aria-label="Reading session controls">
			<button type="button" onClick={() => { setPanel(panel === "library" ? null : "library"); void refreshLibrary().catch(failure => setError(String(failure))); }} data-testid="reader-library"><BookMarkedIcon />My reading</button>
			<button type="button" disabled={!props.documentName || props.loading || saving || restoring} onClick={() => void save()} data-testid="reader-save"><SaveIcon />{saving ? "Saving…" : session ? "Saved" : "Save session"}</button>
			<button type="button" disabled={!props.documentName || props.loading || restoring} onClick={openCheck} data-testid="reader-check-open"><CheckCheckIcon />Check understanding</button>
			<span title={message}>{message || (session ? "Autosave on" : "Save your place and notes")}</span>
			<CloudSyncIndicator />
		</div>
		{panel && <div className={styles.backdrop} onPointerDown={event => { if (event.target === event.currentTarget) setPanel(null); }}>
			<section ref={panelElement} className={styles.panel} role="dialog" aria-modal="true" aria-label={panel === "library" ? "Saved reading sessions" : "Check understanding"} data-testid="reader-workspace-panel">
				<header><div><small>YOUR READING WORKSPACE</small><h2>{panel === "library" ? "Pick up where you left off." : `Explain page ${props.page}.`}</h2></div><button type="button" aria-label="Close reading panel" onClick={() => setPanel(null)}><XIcon /></button></header>
				{error && <div className={styles.error} role="alert">{error}{modelSetupError && <button type="button" onClick={() => openSettings("agent")}>Model settings</button>}</div>}
				{panel === "library" ? <>
					<p>PDFs, your place, voice settings, and understanding checks stay on this computer. Resuming never starts speech.</p>
					{!library.length && <div className={styles.empty}>Open a PDF and choose <b>Save session</b> to start your library.</div>}
					{library.map(item => <button type="button" key={item.id} className={styles.session} disabled={restoring} onClick={() => void resume(item.id)} data-testid="reader-saved-session"><strong>{item.documentName}</strong><span>Page {item.page} / {item.pageCount} <span>Resume →</span></span></button>)}
				</> : <>
					<p>Put the main ideas into your own words. The tutor checks their meaning against this page and your chosen chapter, then asks one follow-up question.</p>
					<div className={styles.context}><label>Chapter context{chapters.length > 0 && <select aria-label="Choose PDF chapter" value="" onChange={event => { const choice = chapters[Number(event.target.value)]; if (choice) setChapter(choice); }}><option value="">Choose a PDF bookmark…</option>{chapters.map((choice, index) => <option key={index} value={index}>{choice.title} · {choice.start}–{choice.end}</option>)}</select>}</label><div><label>From page<input aria-label="Chapter first page" type="number" min="1" max={props.pageCount} value={chapter.start} onChange={event => setChapter(previous => ({ ...previous, start: Number(event.target.value) }))} /></label><label>To page<input aria-label="Chapter last page" type="number" min={chapter.start} max={props.pageCount} value={chapter.end} onChange={event => setChapter(previous => ({ ...previous, end: Number(event.target.value) }))} /></label><label>Feedback<select aria-label="Feedback language" value={language} onChange={event => setLanguage(event.target.value as "en" | "sv")}><option value="en">English</option><option value="sv">Svenska</option></select></label></div></div>
					<label className={styles.rephrase}>My explanation<textarea data-testid="reader-rephrase" rows={6} maxLength={6000} value={drafts[String(props.page)] || ""} placeholder={language === "sv" ? "Förklara sidans viktigaste idéer med egna ord…" : "Explain the page's main ideas in your own words…"} onChange={event => changeDraft(event.target.value)} /></label>
					<button type="button" className={styles.primary} disabled={checking || saving || props.loading} onClick={() => void check()} data-testid="reader-check-submit">{checking ? "Checking in the background…" : "Check my understanding"}</button>
					<small className={styles.disclosure}>This sends your rephrase and the selected chapter pages to your configured AI provider. Saving and read aloud remain local. Feedback is evidence about understanding, not proof of mastery.</small>
					{pageAttempts.map(attempt => <article className={styles.attempt} key={attempt.id} data-testid="reader-feedback"><small>PAGE {attempt.page} · {attempt.status === "pending" ? "CHECKING" : new Date(attempt.createdAt).toLocaleString()}</small><blockquote>{attempt.rephrase}</blockquote>{attempt.error && <p role="alert">{attempt.error}</p>}{attempt.status === "pending" && <p>Your rephrase is saved. You can keep reading while the check runs.</p>}{attempt.result && <><p>{attempt.result.summary}</p>{([['accurate', 'What you understood'], ['missing', 'Ideas to revisit'], ['corrections', 'Corrections']] as const).map(([key, title]) => attempt.result![key].length > 0 && <section key={key}><h3>{title}</h3><ul>{attempt.result![key].map((point, index) => <li key={index}>{point.text} <small>p. {point.pages.join(", ")}</small></li>)}</ul></section>)}<h3>Try applying it</h3><p>{attempt.result.followUpQuestion}</p></>}</article>)}
				</>}
			</section>
		</div>}
		{!panel && error && <div className={styles.inlineError} role="alert">{error}</div>}
	</>;
}
