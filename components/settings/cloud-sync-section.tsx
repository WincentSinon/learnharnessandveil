"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";

export interface CloudSyncStatus {
	configured: boolean;
	url: string;
	keyConfigured: boolean;
	account: { id: string; email?: string } | null;
	enabled: boolean;
	state: "unconfigured" | "signed-out" | "idle" | "syncing" | "synced" | "offline" | "error";
	lastSyncedAt?: string | null;
	pendingCount?: number;
	conflictCount?: number;
	error?: string | null;
	setupRequired?: boolean;
}

interface SyncResponse { status?: CloudSyncStatus; message?: string; error?: string }

export function cloudSyncStatusText(status: CloudSyncStatus | null): string {
	if (!status) return "Loading sync status…";
	if (status.state === "syncing") return "Syncing…";
	if (status.state === "offline") return "Offline · changes stay on this device";
	if (status.state === "error") return "Sync needs attention";
	if (!status.configured) return "Saved locally · cloud sync is not configured";
	if (!status.account) return "Saved locally · sign in to sync";
	if (!status.enabled) return "Saved locally · automatic sync is off";
	if (status.state === "synced") return "Synced";
	return "Saved locally · waiting to sync";
}

function publicStatus(body: SyncResponse | CloudSyncStatus): CloudSyncStatus | null {
	const status = "status" in body ? body.status : body;
	return status && "configured" in status && typeof status.configured === "boolean" ? status as CloudSyncStatus : null;
}

function lastSyncLabel(value?: string | null): string {
	if (!value) return "Not synced yet";
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Not synced yet";
}

const fieldClass = "h-9 w-full min-w-0 rounded-sm border border-border bg-background px-2 font-ui text-sm outline-none focus:border-muted-foreground disabled:opacity-50";
const buttonClass = "rounded-sm border border-border bg-background px-3 py-1.5 font-ui text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40";

/** Credentials and cloud sessions are held by the local server. This UI never
 * persists keys/passwords or receives access/refresh tokens. */
export function CloudSyncSection() {
	const [status, setStatus] = useState<CloudSyncStatus | null>(null);
	const [url, setUrl] = useState("");
	const [key, setKey] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [authMode, setAuthMode] = useState<"sign-in" | "sign-up">("sign-in");
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [connectionError, setConnectionError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [sql, setSql] = useState<string | null>(null);
	const [copying, setCopying] = useState(false);
	const initialized = useRef(false);
	const mounted = useRef(true);
	const busyRef = useRef(false);
	const revision = useRef(0);
	const sqlField = useRef<HTMLTextAreaElement>(null);

	const acceptStatus = useCallback((next: CloudSyncStatus) => {
		setStatus(next);
		if (!initialized.current) { initialized.current = true; setUrl(next.url || ""); }
	}, []);

	const refresh = useCallback(async () => {
		if (busyRef.current) return;
		const request = revision.current;
		try {
			const response = await fetch("/api/cloud-sync", { cache: "no-store" });
			const body = await response.json() as SyncResponse | CloudSyncStatus;
			if (!response.ok) throw new Error("error" in body && body.error || "Cloud sync status could not be loaded.");
			const next = publicStatus(body);
			if (!next) throw new Error("Cloud sync status could not be loaded.");
			if (mounted.current && request === revision.current) { acceptStatus(next); setConnectionError(null); }
		} catch {
			if (mounted.current && request === revision.current) setConnectionError("Could not reach the app's sync service. Your local sessions are still available.");
		}
	}, [acceptStatus]);

	useEffect(() => {
		mounted.current = true;
		void refresh();
		const timer = setInterval(() => void refresh(), 4000);
		return () => { mounted.current = false; clearInterval(timer); };
	}, [refresh]);

	async function action(name: string, values: Record<string, unknown> = {}) {
		if (busyRef.current) return;
		busyRef.current = true; revision.current++; setBusy(name); setError(null); setMessage(null);
		try {
			const response = await fetch("/api/cloud-sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: name, ...values }) });
			const body = await response.json() as SyncResponse | CloudSyncStatus;
			if (!mounted.current) return;
			const next = publicStatus(body); if (next) acceptStatus(next);
			setConnectionError(null);
			window.dispatchEvent(new window.Event("veil:cloud-sync-settings"));
			if (!response.ok) throw new Error("error" in body && body.error || "Cloud sync could not complete the action.");
			if ("message" in body && body.message) setMessage(body.message);
			else if (name === "configure") setMessage("Project saved on this device. Sign in, then enable automatic sync.");
			else if (name === "sign-out") setMessage("Signed out. Your local sessions remain available.");
			if (name === "configure") setKey("");
		} catch (failure) {
			if (mounted.current) setError(failure instanceof Error ? failure.message : "Cloud sync could not complete the action.");
		} finally {
			busyRef.current = false;
			if (mounted.current) { setBusy(null); if (name === "sign-in" || name === "sign-up") setPassword(""); }
		}
	}

	function saveProject(event: FormEvent<HTMLFormElement>) {
		event.preventDefault(); void action("configure", { url: url.trim(), key: key.trim() });
	}

	async function copySetup() {
		setCopying(true); setError(null); setMessage(null);
		try {
			const response = await fetch("/api/cloud-sync/setup", { cache: "no-store" });
			if (!response.ok) throw new Error("The setup SQL could not be loaded.");
			const text = await response.text();
			if (!mounted.current) return;
			try {
				await navigator.clipboard.writeText(text);
				if (mounted.current) setMessage("Setup SQL copied. Run it once in your Supabase project's SQL Editor.");
			} catch {
				setSql(text); setMessage("Select the setup SQL below and copy it into your Supabase project's SQL Editor.");
				requestAnimationFrame(() => { sqlField.current?.focus(); sqlField.current?.select(); });
			}
		} catch (failure) {
			if (mounted.current) setError(failure instanceof Error ? failure.message : "The setup SQL could not be loaded.");
		} finally { if (mounted.current) setCopying(false); }
	}

	const locked = Boolean(busy);
	const account = status?.account;
	const syncError = error || connectionError || status?.error;
	return <div data-testid="cloud-sync-section">
		<p className="font-prose text-sm text-muted-foreground">Use the same Supabase project and account on both computers. Sessions save locally first and sync when you are online.</p>
		<div className="mt-4 rounded-sm border border-border px-3 py-2" role="status" aria-live="polite" data-testid="cloud-sync-status">
			<p className="text-sm">{cloudSyncStatusText(status)}</p>
			<p className="mt-1 text-xs text-muted-foreground">Last sync: {lastSyncLabel(status?.lastSyncedAt)}{typeof status?.pendingCount === "number" ? ` · ${status.pendingCount} pending` : ""}</p>
		</div>
		{syncError && <p role="alert" className="mt-3 break-words rounded-sm border border-red-500/40 px-3 py-2 text-xs text-red-500" data-testid="cloud-sync-error">{syncError}</p>}
		{message && <p role="status" className="mt-3 text-xs text-muted-foreground" data-testid="cloud-sync-message">{message}</p>}
		{!!status?.conflictCount && <p className="mt-3 text-xs text-muted-foreground" data-testid="cloud-sync-conflicts">{status.conflictCount} conflicting {status.conflictCount === 1 ? "version was" : "versions were"} preserved. Study and reading copies are labelled “conflict copy” in Sessions and My reading.</p>}

		<SettingsGroup label="1. Connect your project">
			<form onSubmit={saveProject} className="flex flex-col gap-3" data-testid="cloud-sync-project-form">
				<label className="flex flex-col gap-1 text-xs" htmlFor="cloud-project-url">Supabase project URL<input id="cloud-project-url" data-testid="cloud-project-url" className={fieldClass} type="url" required placeholder="https://your-project.supabase.co" autoComplete="off" value={url} onChange={event => setUrl(event.target.value)} disabled={locked} /></label>
				<label className="flex flex-col gap-1 text-xs" htmlFor="cloud-project-key">Publishable key or legacy anon key<div className="flex gap-2"><input id="cloud-project-key" data-testid="cloud-project-key" className={fieldClass} type={showKey ? "text" : "password"} autoComplete="off" placeholder={status?.keyConfigured ? "Key saved · leave blank to keep it" : "sb_publishable_… or legacy anon key"} required={!status?.keyConfigured} value={key} onChange={event => setKey(event.target.value)} disabled={locked} /><button type="button" className={buttonClass} aria-label={showKey ? "Hide project key" : "Show project key"} onClick={() => setShowKey(value => !value)}>{showKey ? "Hide" : "Show"}</button></div></label>
				<p className="text-xs text-muted-foreground">Find these in Supabase → Project Settings → API Keys. Use a publishable or anon key; never a secret or service_role key.</p>
				<div><button type="submit" className={buttonClass} disabled={locked || !url.trim() || (!key.trim() && !status?.keyConfigured)} data-testid="cloud-save-project">{busy === "configure" ? "Saving…" : "Save project"}</button></div>
			</form>
		</SettingsGroup>

		<SettingsGroup label="2. Set up cloud storage once">
			<p className="font-prose text-sm text-muted-foreground">In your Supabase project's SQL Editor, run the setup SQL once. It creates private storage and account access rules for your study data.</p>
			<div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} onClick={() => void copySetup()} disabled={copying} data-testid="cloud-copy-setup">{copying ? "Loading…" : "Copy setup SQL"}</button><a className={buttonClass} href="/api/cloud-sync/setup" download="veil-cloud-sync.sql" data-testid="cloud-download-setup">Download SQL</a></div>
			{status?.setupRequired && <p className="text-xs text-muted-foreground">Cloud storage needs setup. Run the SQL, then try Sync now again.</p>}
			{sql && <textarea ref={sqlField} aria-label="Cloud sync setup SQL" data-testid="cloud-setup-sql" className="h-40 w-full rounded-sm border border-border bg-background p-2 font-mono text-xs" readOnly value={sql} />}
		</SettingsGroup>

		<SettingsGroup label="3. Your sync account">
			{account ? <div className="flex flex-wrap items-center gap-3"><span className="min-w-0 break-all font-prose text-sm" data-testid="cloud-sync-account">Signed in as {account.email || "your cloud account"}</span><button type="button" className={buttonClass} onClick={() => void action("sign-out")} disabled={locked} data-testid="cloud-sign-out">{busy === "sign-out" ? "Signing out…" : "Sign out"}</button></div> : <>
				<div className="flex gap-2" role="group" aria-label="Sync account action"><button type="button" className={`${buttonClass} ${authMode === "sign-in" ? "bg-accent" : ""}`} aria-pressed={authMode === "sign-in"} onClick={() => setAuthMode("sign-in")} disabled={locked}>Sign in</button><button type="button" className={`${buttonClass} ${authMode === "sign-up" ? "bg-accent" : ""}`} aria-pressed={authMode === "sign-up"} onClick={() => setAuthMode("sign-up")} disabled={locked} data-testid="cloud-create-account-mode">Create account</button></div>
				<form className="mt-2 flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void action(authMode, { email: email.trim(), password }); }} data-testid="cloud-auth-form">
					<label className="flex flex-col gap-1 text-xs" htmlFor="cloud-email">Email<input id="cloud-email" data-testid="cloud-email" className={fieldClass} type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} disabled={locked || !status?.configured} /></label>
					<label className="flex flex-col gap-1 text-xs" htmlFor="cloud-password">Password<input id="cloud-password" data-testid="cloud-password" className={fieldClass} type="password" autoComplete={authMode === "sign-up" ? "new-password" : "current-password"} required value={password} onChange={event => setPassword(event.target.value)} disabled={locked || !status?.configured} /></label>
					<div><button type="submit" className={buttonClass} disabled={locked || !status?.configured || !email.trim() || !password} data-testid="cloud-auth-submit">{busy === "sign-in" || busy === "sign-up" ? "Connecting…" : authMode === "sign-up" ? "Create sync account" : "Sign in to sync"}</button></div>
				</form>
				<p className="text-xs text-muted-foreground">Create one account and use it on both devices. If email confirmation is enabled, confirm your email before signing in.</p>
			</>}
		</SettingsGroup>

		<SettingsGroup label="4. Automatic sync">
			<SettingsRow label="Automatic cloud sync" hint="Uploads your saved PDFs, reading progress, study conversations and learning progress." dimmed={!account}><Toggle label="Automatic cloud sync" checked={status?.enabled ?? false} disabled={locked || !account} onChange={enabled => void action("enable", { enabled })} /></SettingsRow>
			<div><button type="button" className={buttonClass} onClick={() => void action("sync")} disabled={locked || !account || !status?.enabled || status.state === "syncing"} data-testid="cloud-sync-now">{busy === "sync" || status?.state === "syncing" ? "Syncing…" : "Sync now"}</button></div>
			<p className="text-xs text-muted-foreground">AI provider keys, provider logins and downloaded voices stay on this device. Keep the app open until it says Synced before switching computers.</p>
			<p className="text-xs text-muted-foreground">Supabase Free limits individual PDF uploads to 50 MB.</p>
		</SettingsGroup>
	</div>;
}
