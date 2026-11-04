# Veil Study validation — 2026-11-04

This is a Windows development preview based on upstream LearnHarness commit `e69e85269c064c6c9c49a8b06ae78c06e79c4a63`. The fork's first version is `0.4.1-veil.1`.

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
