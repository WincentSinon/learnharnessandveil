/**
 * build-server.mjs — curate the Electron shell's server payload.
 *
 * `next build` (output: "standalone") produces .next/standalone/ with
 * server.js + the traced node_modules subset, but leaves two pieces
 * outside that the docs require us to copy: public/ and .next/static/.
 * This script finishes the job and sanity-checks the result — including
 * the exclusion that keeps the repo's real data/ OUT of the bundle
 * (see next.config.ts outputFileTracingExcludes). It also removes two
 * exact build-only paths the tracer sweeps in: old installers and the
 * development Electron runtime. Broad trace exclusions break externals.
 */
import * as fs from "node:fs";
import { createRequire, registerHooks } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const STANDALONE = path.join(ROOT, ".next", "standalone");

const copyTree = (from, to) => {
	fs.cpSync(from, to, { recursive: true });
};

const exists = (p) => fs.existsSync(p);

if (!exists(path.join(STANDALONE, "server.js"))) {
	console.error("[build-server] .next/standalone/server.js missing — run `next build` first (output: 'standalone').");
	process.exit(1);
}

// 1) Static assets: public/ → standalone/public, .next/static → standalone/.next/static
const staticFrom = path.join(ROOT, ".next", "static");
const staticTo = path.join(STANDALONE, ".next", "static");
if (!exists(staticFrom)) {
	console.error("[build-server] .next/static missing — the build looks incomplete.");
	process.exit(1);
}
copyTree(staticFrom, staticTo);
if (exists(path.join(ROOT, "public"))) {
	copyTree(path.join(ROOT, "public"), path.join(STANDALONE, "public"));
}

// 2) Safety: the repo's real data/ must NEVER ride along in the bundle.
const leakedData = path.join(STANDALONE, "data");
if (exists(leakedData)) {
	console.error("[build-server] REFUSING: standalone contains a data/ directory — repo session data would ship in the app.");
	console.error("             Check outputFileTracingExcludes in next.config.ts.");
	process.exit(1);
}

// 2b) Safety: the repo's dev SECRETS must never ride along either — the
// same trace sweep that catches data/ shipped the repo-root auth.json
// (the DEV BYOK key store, 0600) byte-identical into the DMG (caught in
// the 2026-10-08 payload audit; excluded in next.config.ts — this guard
// makes a regression loud instead of silent).
const subscriptionSecrets = fs.readdirSync(STANDALONE).filter((name) => /^(chatgpt|github-copilot|xai)-credentials\.json/.test(name));
for (const secret of ["auth.json", ...subscriptionSecrets, ".env", ".env.local"]) {
	if (exists(path.join(STANDALONE, secret))) {
		console.error(`[build-server] REFUSING: standalone contains ${secret} — dev secrets would ship in the app.`);
		console.error("             Check outputFileTracingExcludes in next.config.ts.");
		process.exit(1);
	}
}

// 2c) Payload curation (2026-10-11): the trace sweep can copy repo-root
// dist/ (previous installers, recursively) and the development Electron
// runtime (the demo helper's dev-only require). Neither belongs in the
// server: packaged helpers use process.execPath, the app's own binary.
// Remove ONLY these standalone-root paths AFTER tracing — excluding a
// generic dist/** earlier broke pi-ai / pi-agent-core's runtime dist/.
// Never touch ROOT/dist or ROOT/node_modules/electron (the running app
// and the build runtime); native canvas/resvg packages stay untouched.
for (const extra of ["dist", "test-results", ".git", path.join("node_modules", "electron")]) {
	const target = path.resolve(STANDALONE, extra);
	if (!target.startsWith(`${path.resolve(STANDALONE)}${path.sep}`)) throw new Error("Build cleanup escaped the standalone payload.");
	if (exists(target)) {
		fs.rmSync(target, { recursive: true, force: true });
		console.log(`[build-server] removed build-only payload: ${extra}`);
	}
}

// 3) Sanity: the runtime-read prompt assets must be present (the teacher
//    agent reads them from disk at request time).
for (const asset of [
	path.join("src", "agent", "system-prompt.md"),
	path.join("src", "agent", "prompts", "teacher", "20-teaching.md"),
]) {
	if (!exists(path.join(STANDALONE, asset))) {
		console.error(`[build-server] prompt asset missing from the trace: ${asset}`);
		process.exit(1);
	}
}

// Turbopack externalizes Shiki for chat-page SSR. Its hashed alias lives in
// .next/node_modules, outside @streamdown/code's nested dependency tree. Put
// the matching Shiki scope beside that alias so Node can resolve it in the
// installer, including the language, theme and WASM imports loaded on demand.
const externalModules = path.join(STANDALONE, ".next", "node_modules");
const shikiAliases = exists(externalModules)
	? fs.readdirSync(externalModules, { withFileTypes: true }).filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && /^shiki-[a-f0-9]+$/.test(entry.name))
	: [];
if (shikiAliases.length) {
	const codeRequire = createRequire(path.join(ROOT, "node_modules", "@streamdown", "code", "package.json"));
	const shikiManifestPath = codeRequire.resolve("shiki/package.json");
	const shikiRequire = createRequire(shikiManifestPath);
	const readManifest = file => JSON.parse(fs.readFileSync(file, "utf8"));
	const shiki = readManifest(shikiManifestPath);
	const installedModules = fs.realpathSync(path.join(ROOT, "node_modules"));
	const payload = fs.realpathSync(STANDALONE);
	const isWithin = (root, target) => {
		const relative = path.relative(root, target);
		return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
	};
	if (!isWithin(payload, fs.realpathSync(externalModules))) throw new Error("External modules escaped the standalone payload.");
	for (const entry of shikiAliases) {
		const { name } = entry;
		const alias = path.join(externalModules, name);
		if (entry.isSymbolicLink()) {
			// Node resolves Next's junction back to @streamdown/code, but Electron
			// Builder ships a separate directory. Test that physical layout here.
			const target = fs.realpathSync(alias);
			if (!isWithin(payload, target) || !fs.statSync(target).isDirectory()) throw new Error(`Invalid standalone Shiki link: ${name}`);
			const staging = fs.mkdtempSync(path.join(externalModules, ".shiki-package-"));
			const packageCopy = path.join(staging, "package"), originalLink = path.join(staging, "link");
			try {
				copyTree(target, packageCopy);
				fs.renameSync(alias, originalLink);
				try { fs.renameSync(packageCopy, alias); }
				catch (error) { fs.renameSync(originalLink, alias); throw error; }
			} finally {
				if (exists(alias) && isWithin(payload, fs.realpathSync(staging))) fs.rmSync(staging, { recursive: true, force: true });
			}
		}
		const manifest = readManifest(path.join(alias, "package.json"));
		if (manifest.name !== shiki.name || manifest.version !== shiki.version) throw new Error(`Shiki version mismatch in ${name}.`);
		for (const dependency of Object.keys(shiki.dependencies ?? {})) {
			if (!/^@shikijs\/[a-z0-9-]+$/.test(dependency)) continue;
			const source = shikiRequire.resolve.paths(dependency)
				.map(directory => path.join(directory, dependency))
				.find(directory => exists(path.join(directory, "package.json")) && isWithin(installedModules, fs.realpathSync(directory)));
			if (!source) throw new Error(`Cannot find the installed Shiki dependency ${dependency}.`);
			copyTree(source, path.join(alias, "node_modules", dependency));
		}
		// Exercise the exact external used by SSR, including one real highlight.
		// The development checkout can otherwise hide missing payload imports.
		const hooks = registerHooks({
			resolve(specifier, context, nextResolve) {
				const result = nextResolve(specifier, context);
				if (result.url.startsWith("file:") && !isWithin(payload, fs.realpathSync(fileURLToPath(result.url)))) {
					throw new Error(`Shiki runtime import escaped the standalone payload: ${specifier}`);
				}
				if (!result.url.startsWith("file:") && !result.url.startsWith("node:")) throw new Error(`Unexpected Shiki runtime import: ${specifier}`);
				return result;
			},
		});
		try {
			const { codeToHtml } = await import(pathToFileURL(path.join(alias, "dist", "bundle-full.mjs")).href);
			const html = await codeToHtml("echo veil", { lang: "bash", theme: "github-dark" });
			if (!html.includes('class="shiki ')) throw new Error("Shiki did not render the test code block.");
			console.log(`[build-server] ${name} rendered a code block from the standalone payload`);
		} finally { hooks.deregister(); }
	}
}

console.log("[build-server] server payload ready:", STANDALONE);
