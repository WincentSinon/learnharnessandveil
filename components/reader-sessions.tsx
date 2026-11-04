"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRightIcon, BookOpenIcon, ChevronDownIcon, ChevronUpIcon, SettingsIcon } from "lucide-react";
import { READER_STUDIES_CHANGED, type PassageStudyInput, type ReaderStudyRecord } from "@/src/core";
import { createReaderStudyClient } from "@/components/reader-study-client";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import styles from "./reader-sessions.module.css";

let client: ReturnType<typeof createReaderStudyClient> | undefined;
function studyClient() {
	if (typeof window === "undefined") throw new Error("Open the floating reader to start a session.");
	if (!client) {
		let storage: Storage | undefined;
		try { storage = window.localStorage; } catch { /* Session tracking can still live in memory. */ }
		client = createReaderStudyClient({ fetchImpl: window.fetch.bind(window), storage,
			onChange: () => window.dispatchEvent(new Event(READER_STUDIES_CHANGED)) });
	}
	return client;
}

export async function startPassageSession(input: PassageStudyInput): Promise<{ id: string; title: string }> {
	return studyClient().start(input);
}

/** Opening is always explicit; admission and progress updates never steal focus. */
export async function openReaderSession(id: string): Promise<void> {
	if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid study session.");
	if (window.lh?.overlay) await window.lh.overlay.openSession(id);
	else window.open(`/chat/${encodeURIComponent(id)}`, "_blank", "noopener,noreferrer");
}

const STATE_TEXT = { starting: "Starting…", working: "Working in background", waiting: "Your input is ready", ready: "Ready to continue", error: "Needs attention" } as const;

export function ReaderSessions({ documentName, onReveal }: { documentName: string; onReveal: (page: number) => void }) {
	const [records, setRecords] = useState<ReaderStudyRecord[]>([]);
	const [expanded, setExpanded] = useState(true);
	const [error, setError] = useState("");
	const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const { open: openSettings } = useSettingsDialog();
	const refresh = useCallback(() => {
		clearTimeout(refreshTimer.current);
		refreshTimer.current = setTimeout(() => {
			void studyClient().refresh().then(records => { setRecords(records); setError(""); }).catch(() => {
				setRecords(studyClient().list());
				setError("Session updates are unavailable. Your PDF is still open.");
			});
		}, 100);
	}, []);
	useServerEvent("turn-started", refresh);
	useServerEvent("turn-settled", refresh);
	useServerEvent("chats-changed", refresh);
	useServerEvent("record-changed", refresh);
	useServerEvent("compaction-changed", refresh);
	useServerResync(refresh);
	useEffect(() => {
		const read = () => { setRecords(studyClient().list()); };
		read();
		refresh();
		window.addEventListener(READER_STUDIES_CHANGED, read);
		window.addEventListener("storage", read);
		return () => {
			clearTimeout(refreshTimer.current);
			window.removeEventListener(READER_STUDIES_CHANGED, read);
			window.removeEventListener("storage", read);
		};
	}, [refresh]);
	// A new PDF must not hide work already running for another document.
	const visible = records;
	const working = visible.filter(record => record.state === "working" || record.state === "starting").length;
	const waiting = visible.filter(record => record.state === "waiting").length;
	return <section className={styles.panel} aria-label="Background study sessions" data-testid="reader-sessions">
		<div className={styles.header}>
			<button className={styles.toggle} onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
				<BookOpenIcon size={14} /><span>Study sessions</span>
				<span className={styles.count}>{visible.length}</span>
				{working > 0 && <span className={styles.summary}>{working} working</span>}
				{waiting > 0 && <span className={styles.waiting}>{waiting} waiting for you</span>}
				{expanded ? <ChevronDownIcon size={14} /> : <ChevronUpIcon size={14} />}
			</button>
			<button className={styles.settings} onClick={() => openSettings("agent")} title="Configure study models" aria-label="Study settings"><SettingsIcon size={14} /></button>
		</div>
		{expanded && <div className={styles.list}>
			{visible.length === 0 && <p className={styles.empty}>Select a passage and right-click to start. Keep reading while the session works.</p>}
			{visible.map(record => <article className={styles.card} key={record.id} data-testid="reader-session-card" data-session-state={record.state}>
				<div className={styles.cardHeading}><span className={`${styles.dot} ${styles[record.state]}`} /><strong>{record.mode === "practice" ? "Practice" : "Study"} · Page {record.page}</strong><span className={styles.state}>{STATE_TEXT[record.state]}</span></div>
				<p className={styles.source} title={record.documentName}>{record.documentName}</p>
				<p className={styles.quote}>{record.quote}</p>
				{record.error && <p className={styles.error}>{record.error}</p>}
				<div className={styles.actions}>
					<button onClick={() => { void openReaderSession(record.id).catch(reason => setError(reason instanceof Error ? reason.message : "Could not open this session.")); }} data-testid="reader-open-session">Open session <ArrowUpRightIcon size={12} /></button>
					{record.documentName === documentName && <button onClick={() => onReveal(record.page)}>Return to passage</button>}
				</div>
			</article>)}
			{error && <p className={styles.error} role="status">{error}</p>}
		</div>}
	</section>;
}
