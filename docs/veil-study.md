# Veil Study preview

Veil Study is a personal productivity fork of [LearnHarness](https://github.com/amosblomqvist/learnharness), focused on a floating PDF reader and study sessions that can work while you read or use another app. The upstream teaching, practice, provider settings, and learning graph remain available.

## Daily use

1. Launch **Veil Study**. The floating reader is the initial desktop window.
2. Choose a PDF or drop one into the reader. Scroll with the pointer over the document; use the page controls or Page Up / Page Down to jump.
3. Adjust **Opacity** from 20% to 100%, and toggle the pin to keep the reader above other windows.
4. Select a passage on one page, right-click, and choose **Study this passage** or **Practice this passage**.
5. Optionally add a question, then start the session. The reader stays in place. You can continue reading, switch PDFs, or return to another application.
6. **Study sessions** shows all indexed background sessions, including work started from other documents. “Working in background” means the server is active; “Your input is ready” means it has a question or problem for you. These updates do not bring a window to the front.
7. Choose **Open session** when you want the full tutor interface. It retains LearnHarness's structured question, answer, practice, and lesson controls. **Return to passage** is available when the corresponding source filename is open.

**Ctrl+Alt+Space** hides/reveals the reader if the shortcut is available. **Ctrl+Shift+P** opens it from the application menu. Hiding or closing the reader window keeps its document and background work alive; use the application's **Quit** action to stop the app. Opacity and pinning are remembered.

## Model setup

Open the reader's gear icon. Configure a provider or supported subscription connection in **Providers**, then select the **strong**, **cheap**, and **vision** model slots in **Agent**. There are no preset model choices or embedded credentials.

PDF reading does not require a model. Starting study requires configured models; missing configuration produces a local explanation before an empty session is created. Live requests use your selected provider and its billing/connection rules. Provider authentication must be completed by you.

The floating reader sends the selected text, filename, page, and your question into the session. It does not automatically import or upload the whole PDF. Source text is labeled as quoted material. Each new study action is explicit; uncertain request failures are retained for inspection rather than automatically retried.

## Local data and scope

- The desktop fork uses a separate **Veil Study** application profile, independent from upstream LearnHarness and the original Veil PDF Overlay prototype.
- LearnHarness owns canonical sessions, model configuration, and learning data. The reader keeps a small local index of session IDs, source filenames/pages, and short passage previews; it stores no API keys or PDF bytes in that index.
- PDFs remain local and are limited to 100 MB. Text selection needs a text layer; scanned pages need OCR in another tool. Password-protected PDFs prompt for their password.
- Closing/hiding the reader retains the open document for the current app run. Restarting the app requires reopening the PDF; the session index remains available. Source links currently match by filename and page, not a full document fingerprint.
- The preview does not install upstream updates over the fork. Automatic updating stays disabled until a deliberate fork-specific release feed is configured.
- The project and upstream code retain the **AGPL-3.0-only** license. Original author attribution is retained.

## Development on Windows

Use a supported Node LTS release; upstream CI uses Node 26. From the checkout:

```powershell
npm ci
npm run desktop:dev
```

To run the main workspace first during development, set `LH_START_READER=0`. The desktop reader is also available from the sidebar. Browser development at `/reader` supports local PDF input and study transport; native opacity, pinning, and global shortcuts require Electron.

The `predev` and `prebuild` scripts prepare local PDF.js worker, font, CMap, and WASM assets. Generated assets are excluded from version control and retain PDF.js attribution.

```powershell
npm run typecheck
npm run lint
npm run test:reader
npm test
npm run desktop:windows
```

The Windows build command creates `dist/win-unpacked/Veil Study.exe` with its companion runtime files. Keep the whole directory together. It is a development preview, not a signed release.

For the desktop UI regression, install Playwright as a development test dependency or set `LH_PLAYWRIGHT_MODULE` to its existing `index.mjs`. Set `LH_TEST_PDF` to a local selectable multi-page PDF and point `LH_TEST_URL` at the isolated local development server. The test uses a temporary desktop profile, exercises local PDF selection and native controls, and mocks study admission without calling any model.

## Validation record

The reader/transport/native suites, desktop access guards, provider serialization, and fork release-configuration checks are verified separately from the full upstream suite. The first combined focused run passed 173 checks. The production Next build and an Electron-Node standalone-server smoke test passed. Desktop UI checks used a 109-page local PDF: rendering, repeated import, scrolling, opacity, pinning, passage actions, independent study/practice sessions, retained history, and no focus stealing. Live AI responses were not requested.

Some upstream tests assume POSIX file modes, Unix fake executables/signals, or specific CLI availability and fail on this Windows environment. Those are not a claim that every upstream check passes. See the [validation report](veil-validation.md) for final full-suite counts and the baseline comparison.

## Implementation map

- `components/floating-reader.tsx`: local PDF surface, text selection, anchored study actions.
- `components/reader-study-client.ts`: one-shot background admission and local source index.
- `components/reader-sessions.tsx`: quiet, event-driven session status and explicit navigation.
- `electron/overlay.cjs`: narrowly scoped native reader controls and shortcut lifecycle.
- `src/core/reader-study.ts`: source validation, quoted passage prompt, and status/index contracts.

The existing private desktop API boundary is preserved. Reader windows are owned, trusted main frames on the app's private loopback origin; the per-launch API capability is never exposed to a separate companion app.
