# Veil Study validation — 2026-11-04

This is a Windows development preview based on upstream LearnHarness commit `e69e85269c064c6c9c49a8b06ae78c06e79c4a63`. The fork's first version is `0.4.1-veil.1`.

## Reading workspace update — 0.4.1-veil.3

- Added local neural English LJ and Swedish Alma voices, a voice preview, bounded sentence generation, cancellation, and sentence highlights driven by actual audio playback. The voice runtime/models are publisher downloads in the app's local data cache, with pinned SHA-256/size checks. No Python, GPU, speech API key, or inference network request is required.
- Wrapped-word normalization now uses English/Swedish dictionaries, preserves true compounds/acronyms/URLs/suspended compounds, and maps normalized UTF-16 speech ranges back to PDF text runs. Ambiguous hard hyphens still require conservative treatment; exact word timestamps are not available from these neural voices.
- Saved reading sessions retain a SHA-256-addressed local PDF copy, page/fractional position, zoom, voice, speed, chapter selection, per-page drafts, and feedback. Restore stays silent. Session-store tests cover restart, filename collisions, immutable PDF identity, corrupt/future records, and feedback/progress concurrency.
- The structured understanding checker uses the existing configured strong model and provider admission, limits quoted chapter context to 30 pages/120,000 characters, includes the current raw page, validates page citations, persists attempts and usage, and returns one follow-up question. It never writes mastery grades to the knowledge graph. A faux native model verifies the real background/persistence path without a network call.
- **123 focused checks pass** across the new workspace and the earlier native reader, transport, private API, preload and release checks. Typecheck and ESLint pass with the one existing upstream warning.
- Real English and Swedish Piper synthesis produces valid WAV data. Cancellation terminates inference and removes temporary audio. Reader UI tests use real local synthesis and muted media playback to exercise both voices, sentence markers, paused page switching, Stop, saved PDF/progress/preferences/drafts after reload, silent resume, missing-provider guidance, and structured feedback rendering. UI AI feedback is mocked; a live paid model request was not made.
- The packaged application passes the same workspace regression, including a full app/server restart with its temporary profile retained. New reading/session/speech/check endpoints preserve the desktop API boundary: unauthenticated external requests receive 403. A background-throttling setting is disabled only in the test app to make screenshots reliable while other apps are foregrounded.
- Existing 109-page PDF rendering/import/scroll/selection/study-session regressions continue to pass. The broader upstream full-suite results below are from the earlier preview, not a new claim of a green Windows full suite.

## Read aloud update — 0.4.1-veil.2

- Added current-page Read aloud, Pause/Resume, Stop, installed voice selection, and speed controls. Active reading follows manually changed pages and stops at the page end. Paused navigation stays silent; Resume starts the newly selected page. Hiding keeps audio running; PDF replacement, reload, and quit cancel it.
- 116 focused checks pass across narration, native speech validation and races, reader transport, trusted IPC, preload boundaries, and release checks. Typecheck and the production build pass. ESLint reports no errors and the same existing warning recorded below.
- `node scripts/smoke-reader-speech.mjs` exercises the real Windows engine to a temporary WAV: natural completion, pause/resume, silent cancellation while paused, new page after cancellation, and rapid page replacement. It checks a finalized RIFF/WAVE header. No speaker audio or external service is used.
- The real Electron narration UI regression passes in development and in the packaged application with synthetic text/image pages and the local 109-page test PDF. It verifies current-page extraction, navigation/scroll following, pause across pages, voice/rate changes, Stop, stale completion, page-end disarming, OCR guidance, and PDF replacement. Speech transport is mocked in this UI regression; native audio synthesis is tested separately above.
- The packaged application starts directly into one reader, renders the local PDF, enumerates the actual Windows voices through the packaged worker, and preserves private API access (external requests receive 403). The standalone-server/provider/compression smoke gates pass offline.
- This host's standard Windows PowerShell/.NET Framework speech runtime exposes **Microsoft Zira Desktop (en-US)**. Additional voices in a separate modern .NET runtime are not necessarily available to this portable worker. No Windows registry or speech settings are changed.
- The full upstream suite was not repeated for this feature; the full-suite counts below describe the earlier preview and its Windows baseline comparison.

## Passing checks

- TypeScript: `npm run typecheck`.
- ESLint: no errors; one existing warning in an upstream test using a `<head>` element.
- Combined focused regression: 173 passing checks covering reader source contracts and transport, native controls, private API guards, platform/preload boundaries, provider serialization, fork updater behavior, and release-configuration validation.
- The native SDK export-loader regression passes after fixing import-only package resolution on Windows/Node.
- Production Next build passes; its existing dynamic filesystem tracing warnings are retained. The payload curation step excludes private data/auth files and removes test screenshots and build-only payloads.
- Standalone-server smoke passes under Electron's bundled Node: home, graph, model catalog, and settings endpoints return 200. Offline provider and compression/runtime smoke gates pass without generation or network attempts.
- The packaged Windows application launches directly into one reader window, renders the local PDF, and changes native opacity. The owned reader can reach its protected API; an unauthenticated external request receives HTTP 403.
- Real Electron UI checks pass with a local 109-page selectable PDF: first and repeated import, page rendering, wheel scrolling, navigation, native opacity and pinning, selection/right-click, an anchored source bubble, unconfigured-model guidance, independent study/practice admission, source-index restore after reload, and retention of background sessions when another PDF is opened. Model admission/responses are mocked; no live model request was made.

## Full upstream suite on this Windows host

The full run reports **3,197 passed, 10 failed, and 4 skipped** out of 3,211 tests. The remaining failures are:

- POSIX owner-only mode-bit expectations in auth/credential stores and the private CLI directory.
- A Unix signal-escalation expectation in the Claude Code stream fixture.
- A fresh-child import-path expectation in the data-directory test.
- Three Claude Code catalog/availability cases using Unix executable fixtures.
- Two native-subscription credential-file POSIX mode assertions.

These ten failures were reproduced against the unmodified upstream revision in a detached baseline worktree using the same installed dependencies. That baseline subset had eleven failures; the additional native SDK export-resolution failure is fixed in this fork. The remaining platform-specific assertions have not been silently skipped or changed to claim a green suite.

## Preview limits

- A provider/connection and the three model slots still need user configuration for live teaching. Account access, provider billing, and real model quality were not tested.
- Source links use filename and page; exact document fingerprints and persistent highlight geometry are future work.
- PDFs must be reopened after a full app restart. Hiding the reader retains the current document and running server sessions.
- The dependency tree is inherited from upstream. DOMPurify was patched to `3.4.17` within Mermaid's existing allowed range after the audit identified its critical advisory. Other inherited dependency advisories remain for separate review; no broad forced dependency upgrade was made.
- The Windows preview is unsigned. Upstream automatic updates are disabled for the fork unless an explicit fork-specific feed is configured.

The test PDF, screenshots containing its content, local profiles, learning data, and credentials are excluded from source commits. The distributable payload is curated separately from the source checkout.
