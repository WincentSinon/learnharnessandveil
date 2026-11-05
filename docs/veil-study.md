# Veil Study preview

Veil Study is a personal productivity fork of [LearnHarness](https://github.com/amosblomqvist/learnharness), focused on a floating PDF reader and study sessions that can work while you read or use another app. The upstream teaching, practice, provider settings, and learning graph remain available.

## Daily use

1. Launch **Veil Study**. The floating reader is the initial desktop window.
2. Choose a PDF or drop one into the reader. Scroll with the pointer over the document; use the page controls or Page Up / Page Down to jump.
3. Adjust **Opacity** from 20% to 100%, and toggle the pin to keep the reader above other windows.
4. Drag across a word, sentence, or paragraph on one page, then right-click and choose **Study this passage** or **Practice this passage**.
5. Add an optional question. Turn on **Use whole PDF** if the tutor needs context beyond the selection, then start the session. The reader stays in place while the tutor works.
6. **Study sessions** shows all indexed background sessions, including work started from other documents. “Working in background” means the server is active; “Your input is ready” means it has a question or problem for you. These updates do not bring a window to the front.
7. Choose **Open session** when you want the full tutor interface. It retains LearnHarness's structured question, answer, practice, and lesson controls. **Return to passage** is available when the corresponding source filename is open.

**Ctrl+Alt+Space** hides/reveals the reader if the shortcut is available. **Ctrl+Shift+P** opens it from the application menu. Hiding or closing the reader window keeps its document and background work alive; use the application's **Quit** action to stop the app. Opacity and pinning are remembered.

## Read aloud on Windows

The current preview adds **English · LJ (neural)** and **Svenska · Alma (neural)** as local neural voices, alongside the original Windows voice. Choose **Preview** to hear a short sample. On a fresh installation, **Install neural voices** downloads the pinned runtime and models once (about 200 MB); later reading works offline. See [voice sources and licensing](local-voices.md).

Open a PDF, choose an installed **Voice** and **Speed**, then click **Read aloud**. Speech starts at the beginning of the page shown in the page counter. While it is reading, scrolling or navigating to another page cancels the old page and reads the new one. Reading stops at the end of that page; click **Read aloud** again to start another page.

**Pause** keeps speech silent even if you change pages. **Resume** continues from the paused position on the same page, or starts at the beginning of the new page if you navigated while paused. **Stop** cancels speech and turns page following off until you start it again. Changing voice or speed while reading restarts the current page with the new setting. Hiding the reader keeps audio playing so you can work in another application. Opening another PDF, reloading, or quitting stops speech.

Read aloud uses the downloaded local neural voices or a Windows desktop voice. It needs no AI provider or API key, and works offline after setup without uploading PDF text. Available desktop voices depend on the Windows installation. The PDF must contain extractable text; image-only scans need OCR first. PDF text order, columns, formulas, and code may affect the spoken result.

Neural speech normalizes wrapped text and joins dictionary-recognized words split across lines, such as `desk-` / `top`. Genuine compounds, acronyms, URLs, and suspended compounds retain their hyphens. Ambiguous typography can still require checking. **Highlight** marks the sentence actually playing; exact word-level timing is not provided by these voices.

## Study with the whole PDF

**Use whole PDF** attaches the open document to the new study or practice session. The highlighted text sets the starting point. The tutor can consult PDF bookmarks, search for terms, and cite relevant pages. Image-only pages need OCR before their text can be used.

The option saves a copy in **My reading** and uses your existing library sync settings. The configured AI provider receives text from the pages the tutor consults. The saved PDF stays linked to the session when you return to it.

## Save and resume reading

Choose **Save session** after opening a PDF. The app keeps a local, content-addressed PDF copy and automatically saves page/scroll position, zoom, voice, speed, chapter selection, drafts, and understanding feedback. **My reading** lists saved sessions. Resuming restores the PDF and preferences silently; click **Read aloud** yourself when ready. Moving the original PDF does not break the saved copy. PDF passwords are not saved.

## Check understanding

Choose **Check understanding**, select the chapter from PDF bookmarks or enter its page range, and explain the current page in your own words. Choose English or Swedish feedback, then select **Check my understanding**. A check saves the reading session first. It sends the selected chapter's text, current page, and your rephrase to the configured strong model. Context is limited to 30 pages and 120,000 characters, with a smaller limit when the selected model needs one.

Feedback separates accurate ideas, missing ideas, and corrections, cites supplied PDF pages, and asks one follow-up application question. Revise your explanation to try again. Attempts and model usage are saved with the reading session. An answer is evidence about understanding; the app does not claim complete mastery or write a mastery grade to the learning graph. You can keep reading while a check runs. If the app restarts during a check, the saved rephrase remains available and the interrupted check can be submitted again.

## Model setup

Open the reader's gear icon. Configure a provider or supported subscription connection in **Providers**, then select the **strong**, **cheap**, and **vision** model slots in **Agent**. There are no preset model choices or embedded credentials.

PDF reading does not require a model. Starting study requires configured models; missing configuration produces a local explanation before an empty session is created. Live requests use your selected provider and its billing/connection rules. Provider authentication must be completed by you.

The floating reader starts the session with the selected text, filename, page, and your question. Source text is labeled as quoted material. The session is kept for inspection if the app cannot confirm whether a request started.

## Local data and scope

- The desktop fork uses a separate **Veil Study** application profile, independent from upstream LearnHarness and the original Veil PDF Overlay prototype.
- LearnHarness owns canonical sessions, model configuration, and learning data. The reader keeps a small local index of session IDs, source filenames/pages, and short passage previews; it stores no API keys or PDF bytes in that index.
- The reader opens PDFs up to 100 MB. Saved documents follow your Cloud sync settings. Text selection needs a text layer. Run OCR on scanned pages to make their text searchable. Password-protected PDFs prompt for their password.
- Closing/hiding the reader retains the open document for the current app run. After restarting, use **My reading** to restore a saved PDF; unsaved documents must be reopened. Saved reading sessions use PDF SHA-256 identity. Older passage-to-study links still match by filename and page.
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
npm run test:reader:speech
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
- `electron/speech.cjs`: local Windows speech worker and bounded reader-only speech transport.
- `src/core/reader-speech.ts`: speech bridge contracts.
- `src/core/reader-study.ts`: source validation, quoted passage prompt, and status/index contracts.

The existing private desktop API boundary is preserved. Reader windows are owned, trusted main frames on the app's private loopback origin; the per-launch API capability is never exposed to a separate companion app.
