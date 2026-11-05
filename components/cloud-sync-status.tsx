"use client";
import { useEffect, useState } from "react";
import { Cloud, CloudOff, LoaderCircle } from "lucide-react";
import { useSettingsDialog } from "./settings/settings-dialog";
import { useServerEvent } from "./server-events";
import type { CloudSyncStatus } from "./settings/cloud-sync-section";

let latest: CloudSyncStatus | null = null;
const listeners = new Set<(value: CloudSyncStatus | null) => void>();
let request: Promise<void> | null = null;
async function refresh() {
	if (request) return request;
	request = (async () => {
		try {
			const response = await fetch("/api/cloud-sync", { cache: "no-store" });
			if (!response.ok) return;
			latest = await response.json();
			for (const listener of listeners) listener(latest);
		} catch { /* The reader remains usable while its local server reconnects. */ }
	})().finally(() => { request = null; });
	return request;
}
function useCloudStatus() {
	const [status, setStatus] = useState(latest);
	useEffect(() => { listeners.add(setStatus); void refresh(); return () => { listeners.delete(setStatus); }; }, []);
	return status;
}

/** Mounted even before Settings opens, so saved opt-in resumes after an app restart. */
export function CloudSyncBootstrap() {
	useEffect(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), 10_000);
		const updated = () => { void refresh(); };
		window.addEventListener("online", updated); window.addEventListener("focus", updated);
		window.addEventListener("veil:cloud-sync-settings", updated);
		window.addEventListener("veil:study-saved", updated);
		return () => { clearInterval(timer); window.removeEventListener("online", updated); window.removeEventListener("focus", updated); window.removeEventListener("veil:cloud-sync-settings", updated); window.removeEventListener("veil:study-saved", updated); };
	}, []);
	useServerEvent("cloud-sync-changed", () => { void refresh(); });
	useServerEvent("chats-changed", () => { void refresh(); });
	useServerEvent("turn-settled", () => { void refresh(); });
	return null;
}

export function CloudSyncIndicator() {
	const status = useCloudStatus(), { open } = useSettingsDialog();
	const syncing = status?.state === "syncing";
	const attention = status?.state === "offline" || status?.state === "error";
	const label = syncing ? "Syncing…" : status?.enabled && status.state === "synced" ? "Synced" : attention ? "Sync needs attention" : status?.enabled ? "Saved locally" : "Cloud sync";
	return <button type="button" onClick={() => open("cloud-sync")} title={status?.error || "Open cloud sync settings"} aria-label={`Cloud sync: ${label}`} data-testid="reader-cloud-sync">
		{syncing ? <LoaderCircle className="animate-spin" /> : attention ? <CloudOff /> : <Cloud />}{label}
	</button>;
}
