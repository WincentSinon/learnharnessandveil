import * as fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import { cloudProjectConfig, CloudSyncError, readCloudResponseBytes, redactCloudError, type CloudConnection, type CloudProjectConfig } from "./cloud-supabase.ts";

interface CloudAuthSession { fingerprint: string; userId: string; email: string; accessToken: string; refreshToken: string; expiresAt: number }
export interface CloudAuthStatus { configured: boolean; projectUrl: string; keyConfigured: boolean; authenticated: boolean; userId?: string; email?: string }

export function createCloudAuth(options: { directory?: string; fetchImpl?: typeof fetch; now?: () => number } = {}) {
	const directory = options.directory ?? path.join(PATHS.data, "cloud-sync");
	const configPath = path.join(directory, "connection.json"), sessionPath = path.join(directory, "session.json");
	const fetchImpl = options.fetchImpl ?? fetch, now = options.now ?? Date.now;
	let epoch = 0, refreshing: Promise<CloudConnection> | undefined;
	function read<T>(file: string): T | null { try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; } }
	function write(file: string, value: unknown) {
		fs.mkdirSync(directory, { recursive: true }); const temporary = `${file}.${randomUUID()}.tmp`;
		try { fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temporary, file); }
		finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
	}
	function settings(): CloudProjectConfig | null {
		const value = read<CloudProjectConfig>(configPath); if (!value) return null;
		try { return cloudProjectConfig(value); } catch { return null; }
	}
	const fingerprint = (config: CloudProjectConfig) => createHash("sha256").update(`${config.projectUrl}\n${config.publishableKey}`).digest("hex");
	function session(config: CloudProjectConfig): CloudAuthSession | null {
		const value = read<CloudAuthSession>(sessionPath);
		return value?.fingerprint === fingerprint(config) && typeof value.userId === "string" && typeof value.email === "string" && typeof value.accessToken === "string" && !!value.accessToken && typeof value.refreshToken === "string" && !!value.refreshToken && Number.isFinite(value.expiresAt) ? value : null;
	}
	function status(): CloudAuthStatus {
		const config = settings(), current = config && session(config);
		return { configured: !!config, projectUrl: config?.projectUrl ?? "", keyConfigured: !!config?.publishableKey, authenticated: !!current, ...(current ? { userId: current.userId, email: current.email } : {}) };
	}
	async function authRequest(config: CloudProjectConfig, route: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
		let response: Response;
		try { response = await fetchImpl(`${config.projectUrl}/auth/v1/${route}`, { method: "POST", headers: { apikey: config.publishableKey, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(25_000), redirect: "error" }); }
		catch { throw new CloudSyncError("Could not reach your Supabase project. Check your connection and project URL; local saves still work.", "cloud_offline"); }
		let value: Record<string, unknown> = {};
		const bytes = await readCloudResponseBytes(response, 64 * 1024, "cloud_auth_failed", "The cloud sign-in response was too large. Check the project URL.");
		if (bytes.length) {
			try {
				const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid cloud authentication response.");
				value = parsed as Record<string, unknown>;
			} catch { throw new CloudSyncError("The cloud returned an unreadable sign-in response. Check the project URL and try again.", "cloud_auth_failed", response.status); }
		}
		if (!response.ok) {
			const secretBody = body as { password?: string; refresh_token?: string };
			const message = typeof value.msg === "string" ? value.msg : typeof value.message === "string" ? value.message : typeof value.error_description === "string" ? value.error_description : "Cloud sign-in failed. Check your project settings, email and password.";
			throw new CloudSyncError(redactCloudError(message, [config.publishableKey, token || "", secretBody?.password || "", secretBody?.refresh_token || ""]), response.status === 429 ? "cloud_auth_rate_limit" : "cloud_auth_failed", response.status);
		}
		return value;
	}
	function storeSession(config: CloudProjectConfig, value: Record<string, unknown>, owner: number): CloudConnection {
		const user = value.user as { id?: unknown; email?: unknown } | undefined;
		if (typeof value.access_token !== "string" || typeof value.refresh_token !== "string" || typeof user?.id !== "string" || typeof user?.email !== "string") throw new CloudSyncError("Supabase did not return a complete sign-in session. Try signing in again.", "cloud_auth_failed");
		if (owner !== epoch || fingerprint(settings() ?? { projectUrl: "", publishableKey: "" }) !== fingerprint(config)) throw new CloudSyncError("Cloud settings changed while signing in. Try again.", "cloud_auth_changed");
		const expiresAt = typeof value.expires_at === "number" ? value.expires_at * 1000 : now() + (typeof value.expires_in === "number" ? value.expires_in : 3600) * 1000;
		const current: CloudAuthSession = { fingerprint: fingerprint(config), userId: user.id, email: user.email, accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt };
		write(sessionPath, current);
		return { ...config, userId: current.userId, accessToken: current.accessToken };
	}
	function requiredConfig() { const config = settings(); if (!config) throw new CloudSyncError("Add your Supabase project URL and publishable key first.", "cloud_config"); return config; }
	function credentials(email: string, password: string) {
		if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || email.length > 320 || typeof password !== "string" || !password || password.length > 4096) throw new CloudSyncError("Enter your cloud account email and password.", "cloud_auth_input");
		return { email: email.trim(), password };
	}
	return {
		settings, status,
		configure(input: CloudProjectConfig) {
			const previous = settings();
			if (!input || typeof input.projectUrl !== "string" || typeof input.publishableKey !== "string") throw new CloudSyncError("Enter your Supabase project URL and publishable key.", "cloud_config");
			const next = cloudProjectConfig({ projectUrl: input.projectUrl, publishableKey: input.publishableKey.trim() || previous?.publishableKey || "" });
			if (!input.publishableKey.trim() && previous && next.projectUrl !== previous.projectUrl) throw new CloudSyncError("Paste the publishable key for the new project URL.", "cloud_config");
			if (!previous || fingerprint(next) !== fingerprint(previous)) { epoch++; refreshing = undefined; fs.rmSync(sessionPath, { force: true }); }
			write(configPath, next); return status();
		},
		async signIn(email: string, password: string) {
			const config = requiredConfig(), owner = ++epoch;
			refreshing = undefined;
			const value = await authRequest(config, "token?grant_type=password", credentials(email, password));
			storeSession(config, value, owner); return status();
		},
		async signUp(email: string, password: string): Promise<{ status: CloudAuthStatus; confirmationRequired: boolean }> {
			const config = requiredConfig(), owner = ++epoch;
			refreshing = undefined;
			const value = await authRequest(config, "signup", credentials(email, password));
			if (value.access_token) { storeSession(config, value, owner); return { status: status(), confirmationRequired: false }; }
			return { status: status(), confirmationRequired: true };
		},
		async signOut() {
			const config = settings(), current = config && session(config); epoch++; refreshing = undefined; fs.rmSync(sessionPath, { force: true });
			if (config && current) { try { await authRequest(config, "logout?scope=local", {}, current.accessToken); } catch { /* Local removal must work offline too. */ } }
			return status();
		},
		async connection(): Promise<CloudConnection> {
			const config = requiredConfig(), current = session(config);
			if (!current) throw new CloudSyncError("Sign in to your cloud account first.", "cloud_auth_required", 401);
			if (current.expiresAt > now() + 60_000) return { ...config, userId: current.userId, accessToken: current.accessToken };
			if (!refreshing) {
				const owner = epoch;
				refreshing = authRequest(config, "token?grant_type=refresh_token", { refresh_token: current.refreshToken }).then(value => storeSession(config, value, owner)).catch(error => {
					if (owner === epoch && error instanceof CloudSyncError && error.code !== "cloud_offline" && error.status !== 429 && error.status < 500) fs.rmSync(sessionPath, { force: true });
					throw error;
				}).finally(() => { if (owner === epoch) refreshing = undefined; });
			}
			return refreshing;
		},
	};
}

export const cloudAuth = createCloudAuth();
