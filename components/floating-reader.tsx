"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayer } from "pdfjs-dist";
import { ArrowDownToLineIcon, BookOpenIcon, ChevronLeftIcon, ChevronRightIcon, DumbbellIcon, FileTextIcon, LayersIcon, MaximizeIcon, MinusIcon, PauseIcon, PinIcon, PlayIcon, PlusIcon, SettingsIcon, SparklesIcon, SquareIcon, Volume2Icon, XIcon } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { ReaderSessions, openReaderSession, startPassageSession } from "@/components/reader-sessions";
import { EMPTY_NARRATION, ReaderNarration, pageSpeechText } from "@/components/reader-narration";
import styles from "./floating-reader.module.css";

type PdfModule = typeof import("pdfjs-dist");
type PdfFile = { name: string; data: Uint8Array };
type Mark = { x: number; y: number; width: number; height: number };
type Page = {
	number: number;
	node: HTMLDivElement;
	canvas: HTMLCanvasElement;
	text: HTMLDivElement;
	annotations: HTMLDivElement;
	width: number;
	height: number;
	proxy: PDFPageProxy | null;
	generation: number;
	visible: boolean;
	busy: boolean;
	rendered: boolean;
	renderTask?: RenderTask;
	textTask?: TextLayer;
};
type Passage = { text: string; page: Page; marks: Mark[]; documentName: string; version: number };
type ReaderCallbacks = {
	documentChanging: () => void;
	loading: (busy: boolean) => void;
	status: (message: string, error?: boolean) => void;
	loaded: (name: string, count: number) => void;
	page: (page: number) => void;
	scale: (scale: number, fit: boolean) => void;
	selection: (passage: Passage, x: number, y: number) => void;
	clearSelection: () => void;
	password: (update: (password: string) => void, cancel: () => void, incorrect: boolean) => void;
};

let pdfModule: Promise<PdfModule> | undefined;
function getPdfModule() {
	// PDF.js depends on browser APIs even when imported by a Client Component.
	// Loading it on demand keeps the server-rendered route free of DOM globals.
	pdfModule ??= import("pdfjs-dist").then((module) => {
		module.GlobalWorkerOptions.workerSrc = "/pdf-assets/pdf.worker.min.mjs";
		return module;
	});
	return pdfModule;
}

function messageOf(error: unknown) {
	return error instanceof Error ? error.message : "The action could not be completed.";
}

/** Local PDF surface; no PDF bytes or page text leave this controller. */
class PdfSurface {
	private pdf: PDFDocumentProxy | null = null;
	private loadingTask: PDFDocumentLoadingTask | null = null;
	private pages: Page[] = [];
	private queue: Page[] = [];
	private active = 0;
	private version = 0;
	private loadVersion = 0;
	private current = 1;
	private scale = 1;
	private fit = true;
	private documentName = "";
	private opening = false;
	private disposed = false;
	private scrollFrame = 0;
	private resizeTimer: ReturnType<typeof setTimeout> | undefined;
	private observer: IntersectionObserver;
	private resizeObserver: ResizeObserver;

	constructor(private viewport: HTMLDivElement, private container: HTMLDivElement, private callbacks: ReaderCallbacks) {
		this.observer = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				const page = this.pages[Number((entry.target as HTMLElement).dataset.page) - 1];
				if (!page || page.node !== entry.target) continue;
				page.visible = entry.isIntersecting;
				if (page.visible) this.enqueue(page);
			}
		}, { root: viewport, rootMargin: "700px 300px" });
		this.resizeObserver = new ResizeObserver(() => {
			clearTimeout(this.resizeTimer);
			this.resizeTimer = setTimeout(() => {
				const next = this.fitScale();
				if (this.pdf && this.fit && !this.disposed && Math.abs(next - this.scale) > 0.005) this.zoom(next, true);
			}, 150);
		});
		this.resizeObserver.observe(viewport);
		viewport.addEventListener("scroll", this.onScroll, { passive: true });
		viewport.addEventListener("contextmenu", this.onContextMenu);
	}

	async load(file: PdfFile) {
		const loadVersion = ++this.loadVersion;
		this.opening = true;
		this.callbacks.loading(true);
		this.callbacks.documentChanging();
		try {
			await this.loadingTask?.destroy().catch(() => {});
			if (this.disposed || loadVersion !== this.loadVersion) return;
			this.callbacks.status(`Opening ${file.name}…`);
			const library = await getPdfModule();
			if (this.disposed || loadVersion !== this.loadVersion) return;
			const task = library.getDocument({
				data: new Uint8Array(file.data),
				cMapUrl: "/pdf-assets/cmaps/",
				standardFontDataUrl: "/pdf-assets/standard_fonts/",
				wasmUrl: "/pdf-assets/wasm/",
				iccUrl: "/pdf-assets/iccs/",
			});
			this.loadingTask = task;
			task.onPassword = (update: (password: string) => void, reason: number) => {
				if (this.disposed || loadVersion !== this.loadVersion) { void task.destroy(); return; }
				this.callbacks.password(update, () => {
					void task.destroy();
					if (loadVersion === this.loadVersion) this.callbacks.status("Opening the protected PDF was cancelled.");
				}, reason === library.PasswordResponses.INCORRECT_PASSWORD);
			};
			const pdf = await task.promise;
			const first = await pdf.getPage(1);
			if (this.disposed || loadVersion !== this.loadVersion) { await task.destroy(); return; }
			this.version++;
			this.callbacks.clearSelection();
			this.observer.disconnect();
			this.queue = [];
			for (const page of this.pages) { page.renderTask?.cancel(); page.textTask?.cancel(); }
			const previous = this.pdf;
			this.pdf = pdf;
			void previous?.loadingTask.destroy().catch(() => {});
			this.pages = [];
			this.documentName = file.name;
			this.current = 1;
			this.fit = true;
			const native = first.getViewport({ scale: 1 });
			this.scale = this.fitScale(native.width);
			this.container.replaceChildren();
			for (let number = 1; number <= pdf.numPages; number++) {
				const node = document.createElement("div");
				node.className = styles.page ?? "";
				node.dataset.page = String(number);
				node.setAttribute("role", "region");
				node.setAttribute("aria-label", `Page ${number}`);
				const canvas = document.createElement("canvas");
				canvas.setAttribute("aria-hidden", "true");
				const text = document.createElement("div");
				text.className = "textLayer";
				const annotations = document.createElement("div");
				annotations.className = styles.annotations ?? "";
				const label = document.createElement("span");
				label.className = styles.pageLabel ?? "";
				label.textContent = String(number).padStart(2, "0");
				label.setAttribute("aria-hidden", "true");
				node.append(canvas, text, annotations, label);
				const page: Page = { number, node, canvas, text, annotations, width: native.width, height: native.height,
					proxy: number === 1 ? first : null, generation: 0, visible: false, busy: false, rendered: false };
				this.size(page);
				this.pages.push(page);
				this.container.append(node);
				this.observer.observe(node);
			}
			this.viewport.scrollTo(0, 0);
			this.callbacks.loaded(file.name, pdf.numPages);
			this.callbacks.page(1);
			this.callbacks.scale(this.scale, true);
			this.callbacks.status("Select text, then right-click to start a study session.");
			const firstRecord = this.pages[0];
			if (firstRecord) this.enqueue(firstRecord);
		} catch (error) {
			if (!this.disposed && loadVersion === this.loadVersion && !(error instanceof Error && error.name === "AbortException")) {
				this.callbacks.status(`Could not open PDF: ${messageOf(error)}`, true);
			}
		} finally {
			if (loadVersion === this.loadVersion) {
				this.loadingTask = null;
				this.opening = false;
				this.callbacks.loading(false);
			}
		}
	}

	private fitScale(width = this.pages[this.current - 1]?.width ?? 612) {
		return Math.max(0.25, Math.min(2, (this.viewport.clientWidth - 48) / width));
	}

	private size(page: Page) {
		page.node.style.width = `${page.width * this.scale}px`;
		page.node.style.height = `${page.height * this.scale}px`;
		page.node.style.setProperty("--total-scale-factor", String(this.scale));
		page.node.style.setProperty("--scale-factor", String(this.scale));
		page.canvas.style.width = "100%";
		page.canvas.style.height = "100%";
	}

	private enqueue(page: Page) {
		if (this.disposed || page.busy || page.rendered || this.queue.includes(page)) return;
		this.queue.push(page);
		this.pump();
	}

	private pump() {
		while (!this.disposed && this.active < 2 && this.queue.length) {
			const page = this.queue.shift();
			if (!page || page.busy || page.rendered || !this.pages.includes(page)) continue;
			this.active++;
			void this.render(page).finally(() => { this.active--; this.pump(); });
		}
	}

	private async render(page: Page) {
		const version = this.version;
		const generation = page.generation;
		page.busy = true;
		const current = () => !this.disposed && version === this.version && generation === page.generation;
		try {
			const proxy = page.proxy ?? await this.pdf!.getPage(page.number);
			if (!current()) return;
			page.proxy = proxy;
			const native = proxy.getViewport({ scale: 1 });
			page.width = native.width;
			page.height = native.height;
			this.size(page);
			const viewport = proxy.getViewport({ scale: this.scale });
			const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(12_000_000 / (viewport.width * viewport.height)));
			page.canvas.width = Math.ceil(viewport.width * ratio);
			page.canvas.height = Math.ceil(viewport.height * ratio);
			const context = page.canvas.getContext("2d", { alpha: false });
			if (!context) throw new Error("Canvas rendering is unavailable.");
			page.renderTask = proxy.render({ canvas: null, canvasContext: context, viewport,
				transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
			await page.renderTask.promise;
			if (!current()) return;
			const content = await proxy.getTextContent();
			if (!current()) return;
			page.text.replaceChildren();
			const library = await getPdfModule();
			if (!current()) return;
			page.textTask = new library.TextLayer({ textContentSource: content, container: page.text, viewport });
			await page.textTask.render();
			if (!current()) return;
			page.rendered = true;
			page.node.dataset.rendered = "true";
			if (page.number === this.current && !content.items.some((item) => "str" in item && item.str.trim())) {
				this.callbacks.status("This page has no selectable text. Scanned pages need OCR before passage selection.");
			}
		} catch (error) {
			if (current() && !(error instanceof Error && ["RenderingCancelledException", "AbortException"].includes(error.name))) {
				this.callbacks.status(`Page ${page.number}: ${messageOf(error)}`, true);
			}
		} finally {
			page.busy = false;
			page.renderTask = undefined;
			page.textTask = undefined;
			if (!this.disposed && version === this.version && generation !== page.generation && page.visible) this.enqueue(page);
		}
	}

	zoom(value: number, fit = false) {
		if (!this.pdf) return;
		const current = this.pages[this.current - 1];
		if (!current) return;
		const fraction = (this.viewport.scrollTop - current.node.offsetTop) / (current.height * this.scale);
		this.scale = Math.max(0.25, Math.min(3, value));
		this.fit = fit;
		this.queue = [];
		window.getSelection()?.removeAllRanges();
		this.callbacks.clearSelection();
		for (const page of this.pages) {
			page.generation++;
			page.renderTask?.cancel();
			page.textTask?.cancel();
			page.rendered = false;
			delete page.node.dataset.rendered;
			page.text.replaceChildren();
			if (!page.busy) page.canvas.width = page.canvas.height = 0;
			this.size(page);
		}
		this.viewport.scrollTop = current.node.offsetTop + fraction * current.height * this.scale;
		this.callbacks.scale(this.scale, fit);
		for (const page of this.pages) if (page.visible) this.enqueue(page);
		this.enqueue(current);
	}

	fitWidth() { this.zoom(this.fitScale(), true); }

	/** Extract independently of the canvas/text-layer render queue. */
	async speechText(number: number): Promise<string | null> {
		const pdf = this.pdf;
		const version = this.loadVersion;
		const record = this.pages[number - 1];
		const current = () => !this.disposed && !this.opening && this.pdf === pdf && version === this.loadVersion;
		if (!pdf || !record || !current()) return null;
		const page = record.proxy ?? await pdf.getPage(number);
		if (!current()) return null;
		const content = await page.getTextContent();
		if (!current()) return null;
		return pageSpeechText(content.items);
	}

	navigate(number: number) {
		if (!this.pdf) return;
		const target = Math.max(1, Math.min(this.pdf.numPages, Math.round(number) || 1));
		const page = this.pages[target - 1];
		if (!page) return;
		this.viewport.scrollTo({ top: Math.max(0, page.node.offsetTop - 20), behavior: "instant" });
		this.current = target;
		this.callbacks.page(target);
		this.enqueue(page);
	}

	private onScroll = () => {
		if (!this.pdf || this.scrollFrame) return;
		this.scrollFrame = requestAnimationFrame(() => {
			this.scrollFrame = 0;
			if (this.disposed) return;
			const target = this.viewport.getBoundingClientRect().top + Math.min(180, this.viewport.clientHeight / 3);
			let closest = this.pages[0];
			for (const page of this.pages) {
				if (page.node.getBoundingClientRect().top <= target) closest = page;
				else break;
			}
			if (!closest) return;
			if (closest.number !== this.current) {
				this.current = closest.number;
				this.callbacks.page(this.current);
			}
			for (const page of this.pages) {
				if (!page.visible && page.rendered && Math.abs(page.number - this.current) > 5) {
					page.canvas.width = page.canvas.height = 0;
					page.text.replaceChildren();
					page.rendered = false;
					delete page.node.dataset.rendered;
					page.proxy?.cleanup();
				}
			}
		});
	};

	private onContextMenu = (event: MouseEvent) => {
		if ((event.target as Element).closest?.("[data-reader-bubble]")) return;
		const selection = window.getSelection();
		if (!selection?.rangeCount || selection.isCollapsed) return;
		const text = selection.toString().trim();
		if (!text) return;
		const range = selection.getRangeAt(0);
		const start = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
		const end = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer as Element : range.endContainer.parentElement;
		if (!start?.closest(".textLayer") || !end?.closest(".textLayer")) return;
		const pageNode = start.closest<HTMLElement>("[data-page]");
		if (!pageNode || end.closest("[data-page]") !== pageNode) {
			this.callbacks.status("Select a passage within one page to link it to a study session.");
			return;
		}
		event.preventDefault();
		if (text.length > 12_000) { this.callbacks.status("Choose a shorter passage (up to 12,000 characters).", true); return; }
		const page = this.pages[Number(pageNode.dataset.page) - 1];
		if (!page) return;
		const bounds = pageNode.getBoundingClientRect();
		const marks = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0).map((rect) => ({
			x: (rect.left - bounds.left) / bounds.width, y: (rect.top - bounds.top) / bounds.height,
			width: rect.width / bounds.width, height: rect.height / bounds.height,
		}));
		if (marks.length) this.callbacks.selection({ text, page, marks, documentName: this.documentName, version: this.version }, event.clientX, event.clientY);
	};

	dispose() {
		this.disposed = true;
		this.loadVersion++;
		this.version++;
		clearTimeout(this.resizeTimer);
		cancelAnimationFrame(this.scrollFrame);
		this.observer.disconnect();
		this.resizeObserver.disconnect();
		this.viewport.removeEventListener("scroll", this.onScroll);
		this.viewport.removeEventListener("contextmenu", this.onContextMenu);
		for (const page of this.pages) { page.renderTask?.cancel(); page.textTask?.cancel(); }
		void this.loadingTask?.destroy().catch(() => {});
		void this.pdf?.loadingTask.destroy().catch(() => {});
	}
}

export function FloatingReader() {
	const viewport = useRef<HTMLDivElement>(null);
	const pages = useRef<HTMLDivElement>(null);
	const surface = useRef<PdfSurface | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const passwordDialog = useRef<HTMLDialogElement>(null);
	const studyRequest = useRef(0);
	const narration = useRef<ReaderNarration | null>(null);
	const [speech, setSpeech] = useState(EMPTY_NARRATION);
	const [fileName, setFileName] = useState("");
	const [pageCount, setPageCount] = useState(0);
	const [pdfOpening, setPdfOpening] = useState(false);
	const [page, setPage] = useState(1);
	const [scale, setScale] = useState(1);
	const [fit, setFit] = useState(true);
	const [opacity, setOpacity] = useState(100);
	const [pinned, setPinned] = useState(true);
	const [native, setNative] = useState(false);
	const [shortcut, setShortcut] = useState(false);
	const [status, setStatus] = useState("Read here. Let your study sessions work in the background.");
	const [statusError, setStatusError] = useState(false);
	const [dragOver, setDragOver] = useState(false);
	const [menu, setMenu] = useState<{ passage: Passage; x: number; y: number } | null>(null);
	const [bubble, setBubble] = useState<Passage | null>(null);
	const [mode, setMode] = useState<"teach" | "practice">("teach");
	const [question, setQuestion] = useState("");
	const [starting, setStarting] = useState(false);
	const [studyError, setStudyError] = useState("");
	const [started, setStarted] = useState<{ id: string; title: string } | null>(null);
	const [password, setPassword] = useState<{ update: (value: string) => void; cancel: () => void; incorrect: boolean } | null>(null);
	const [passwordValue, setPasswordValue] = useState("");
	const { open: openSettings } = useSettingsDialog();

	const report = useCallback((message: string, error = false) => { setStatus(message); setStatusError(error); }, []);
	const clearSelection = useCallback(() => { studyRequest.current++; setStarting(false); setMenu(null); setBubble(null); setStarted(null); setStudyError(""); }, []);
	const closeBubble = useCallback(() => { studyRequest.current++; setStarting(false); setBubble(null); }, []);

	useEffect(() => {
		if (!viewport.current || !pages.current) return;
		const controller = new PdfSurface(viewport.current, pages.current, {
			documentChanging: () => narration.current?.stop(),
			loading: setPdfOpening,
			status: report,
			loaded: (name, count) => { setFileName(name); setPageCount(count); },
			page: (number) => { setPage(number); narration.current?.setPage(number); },
			scale: (next, isFit) => { setScale(next); setFit(isFit); },
			selection: (passage, x, y) => { setMenu({ passage, x, y }); },
			clearSelection,
			password: (update, cancel, incorrect) => { setPasswordValue(""); setPassword({ update, cancel, incorrect }); },
		});
		surface.current = controller;
		return () => { surface.current = null; controller.dispose(); };
	}, [clearSelection, report]);

	useEffect(() => {
		const bridge = window.lh?.overlay;
		setNative(Boolean(bridge));
		void bridge?.state().then((state) => { setOpacity(Math.round(state.opacity * 100)); setPinned(state.pinned); setShortcut(state.shortcutAvailable); }).catch((error: unknown) => report(messageOf(error), true));
		if (window.lh?.platform !== "win32" || !bridge?.speech) return;
		const controller = new ReaderNarration(bridge.speech, async number => surface.current?.speechText(number) ?? null, setSpeech);
		narration.current = controller;
		void controller.initialize();
		return () => { if (narration.current === controller) narration.current = null; controller.dispose(); };
	}, [report]);

	useEffect(() => {
		const dialog = passwordDialog.current;
		if (password && dialog && !dialog.open) dialog.showModal();
		if (!password && dialog?.open) dialog.close();
	}, [password]);

	const loadFile = useCallback(async (file: File) => {
		if (!file.name.toLowerCase().endsWith(".pdf")) { report("Choose a PDF file.", true); return; }
		if (file.size > 100 * 1024 * 1024) { report("Choose a PDF smaller than 100 MB.", true); return; }
		try { await surface.current?.load({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) }); }
		catch (error) { report(messageOf(error), true); }
	}, [report]);

	const openPdf = useCallback(async () => {
		const bridge = window.lh?.overlay;
		if (!bridge) { fileInput.current?.click(); return; }
		try { const file = await bridge.openPdf(); if (file) await surface.current?.load(file); }
		catch (error) { report(messageOf(error), true); }
	}, [report]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !password) { setMenu(null); closeBubble(); }
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") { event.preventDefault(); void openPdf(); }
			if ((event.ctrlKey || event.metaKey) && event.key === ",") { event.preventDefault(); openSettings("agent"); }
			if ((event.target as Element).closest?.("input, textarea, [contenteditable='true']") || password) return;
			if (event.key === "PageDown") { event.preventDefault(); surface.current?.navigate(page + 1); }
			if (event.key === "PageUp") { event.preventDefault(); surface.current?.navigate(page - 1); }
		};
		const hideMenu = (event: PointerEvent) => { if (!(event.target as Element).closest?.("[data-reader-menu]")) setMenu(null); };
		window.addEventListener("keydown", onKey);
		window.addEventListener("pointerdown", hideMenu);
		return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", hideMenu); };
	}, [closeBubble, openPdf, openSettings, page, password]);

	const selectAction = (nextMode: "teach" | "practice") => {
		if (!menu) return;
		studyRequest.current++;
		setStarting(false);
		setBubble(menu.passage);
		setMode(nextMode);
		setQuestion("");
		setStarted(null);
		setStudyError("");
		setMenu(null);
		window.getSelection()?.removeAllRanges();
	};

	const startStudy = async (event: FormEvent) => {
		event.preventDefault();
		if (!bubble || starting) return;
		const request = ++studyRequest.current;
		setStarting(true);
		setStudyError("");
		try {
			const session = await startPassageSession({ documentName: bubble.documentName, page: bubble.page.number,
				text: bubble.text, question: question.trim(), mode });
			if (request !== studyRequest.current) return;
			setStarted(session);
			report(`${mode === "practice" ? "Practice" : "Study"} started in the background. Keep reading.`);
		} catch (error) { if (request === studyRequest.current) setStudyError(messageOf(error)); }
		finally { if (request === studyRequest.current) setStarting(false); }
	};

	let bubbleStyle: CSSProperties = {};
	if (bubble) {
		const first = bubble.marks[0];
		const last = bubble.marks.at(-1);
		const width = Math.min(360, bubble.page.node.clientWidth - 24);
		if (first && last) bubbleStyle = {
			width,
			left: Math.max(12, Math.min(first.x * bubble.page.node.clientWidth, bubble.page.node.clientWidth - width - 12)),
			top: Math.max(12, Math.min((last.y + last.height) * bubble.page.node.clientHeight + 14, bubble.page.node.clientHeight - 330)),
		};
	}

	return (
		<section className={styles.reader} data-testid="floating-reader">
			<TopBar>
				<div className={styles.identity}><LayersIcon aria-hidden="true" /><div><span>Floating reader</span><small>Stay with the page. Let the tutor work.</small></div></div>
				<div className={styles.headerActions}>
					<button type="button" className={styles.openButton} onClick={() => void openPdf()} data-testid="reader-open-pdf"><PlusIcon aria-hidden="true" />Open PDF</button>
					<button type="button" className={styles.iconButton} title="Models and providers" aria-label="Reader settings" onClick={() => openSettings("agent")}><SettingsIcon /></button>
					{native && <button type="button" className={styles.iconButton} title={shortcut ? "Hide reader · Ctrl+Alt+Space" : "Hide reader"} aria-label="Hide floating reader" onClick={() => void window.lh?.overlay?.hide()}><ArrowDownToLineIcon /></button>}
				</div>
			</TopBar>
			<div className={styles.toolbar} aria-label="PDF controls">
				<div className={styles.fileName} title={fileName}><FileTextIcon aria-hidden="true" /><span>{fileName || "No document open"}</span></div>
				<div className={styles.opacityControl} title={native ? "Window opacity" : "Opacity is available in the desktop app"}>
					<label htmlFor="reader-opacity">Opacity</label><input id="reader-opacity" data-testid="reader-opacity" type="range" min="20" max="100" value={opacity} disabled={!native} onChange={(event) => {
						const next = Number(event.target.value); setOpacity(next);
						void window.lh?.overlay?.setOpacity(next / 100).catch((error: unknown) => report(messageOf(error), true));
					}} /><output>{opacity}%</output>
				</div>
				<button type="button" className={styles.iconButton} aria-label="Keep reader on top" aria-pressed={pinned} disabled={!native} data-testid="reader-pin" title={native ? "Always on top" : "Pinning is available in the desktop app"} onClick={() => {
					void window.lh?.overlay?.setPinned(!pinned).then(setPinned).catch((error: unknown) => report(messageOf(error), true));
				}}><PinIcon /></button>
			</div>
			<div className={styles.navigation}>
				<span className={styles.localLabel}><span />{fileName ? "Local PDF" : "Your reading room"}</span>
				<div className={styles.zoomControls}><button type="button" aria-label="Zoom out" className={styles.iconButton} disabled={!pageCount} onClick={() => surface.current?.zoom(scale - 0.15)}><MinusIcon /></button><output>{Math.round(scale * 100)}%</output><button type="button" aria-label="Zoom in" className={styles.iconButton} disabled={!pageCount} onClick={() => surface.current?.zoom(scale + 0.15)}><PlusIcon /></button><button type="button" aria-label="Fit PDF to width" aria-pressed={fit} className={styles.iconButton} disabled={!pageCount} onClick={() => surface.current?.fitWidth()}><MaximizeIcon /></button></div>
				<div className={styles.pageControls}><button type="button" aria-label="Previous PDF page" className={styles.iconButton} disabled={!pageCount} onClick={() => surface.current?.navigate(page - 1)}><ChevronLeftIcon /></button><input data-testid="reader-page" aria-label="PDF page number" type="number" min="1" max={pageCount || 1} value={page} disabled={!pageCount} onChange={(event) => surface.current?.navigate(Number(event.target.value))} /><span>/ {pageCount}</span><button type="button" aria-label="Next PDF page" className={styles.iconButton} disabled={!pageCount} onClick={() => surface.current?.navigate(page + 1)}><ChevronRightIcon /></button></div>
			</div>
			<div className={styles.speechToolbar} aria-label="Read aloud controls" data-testid="reader-speech-controls">
				<button type="button" className={styles.speechStart} disabled={!pageCount || pdfOpening || !speech.available || speech.status === "loading" || speech.status === "speaking" || speech.status === "paused"} onClick={() => narration.current?.read()} data-testid="reader-speech-start"><Volume2Icon aria-hidden="true" />Read aloud</button>
				<button type="button" className={styles.iconButton} disabled={!pageCount || !["loading", "speaking", "paused"].includes(speech.status)} aria-label={speech.status === "paused" ? "Resume reading aloud" : "Pause reading aloud"} title={speech.status === "paused" ? "Resume reading aloud" : "Pause reading aloud"} onClick={() => speech.status === "paused" ? narration.current?.resume() : narration.current?.pause()} data-testid="reader-speech-pause">{speech.status === "paused" ? <PlayIcon /> : <PauseIcon />}</button>
				<button type="button" className={styles.iconButton} disabled={!pageCount || !["loading", "speaking", "paused"].includes(speech.status)} aria-label="Stop reading aloud" title="Stop reading aloud" onClick={() => narration.current?.stop()} data-testid="reader-speech-stop"><SquareIcon /></button>
				<label className={styles.voiceControl}><span>Voice</span><select aria-label="Read aloud voice" data-testid="reader-speech-voice" value={speech.voice} disabled={!speech.available} onChange={event => narration.current?.setVoice(event.target.value)}>{!speech.voices.length && <option value="">Windows voices</option>}{speech.voices.map(voice => <option key={voice.name} value={voice.name}>{voice.name} · {voice.language}</option>)}</select></label>
				<label className={styles.rateControl}><span>Speed</span><select aria-label="Read aloud speed" data-testid="reader-speech-rate" value={speech.rate} disabled={!speech.available} onChange={event => narration.current?.setRate(Number(event.target.value))}><option value={-2}>Slower</option><option value={0}>Normal</option><option value={2}>Faster</option><option value={4}>Very fast</option></select></label>
				<div className={styles.speechStatus} role="status" data-testid="reader-speech-status" data-state={speech.status} title={speech.message}>{speech.message}</div>
			</div>
			<div ref={viewport} className={`${styles.viewport} ${dragOver ? styles.dragOver : ""}`} data-testid="reader-viewport" onScroll={() => setMenu(null)} onDragOver={(event) => { event.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={(event) => { event.preventDefault(); setDragOver(false); const file = event.dataTransfer.files[0]; if (file) void loadFile(file); }}>
				{!fileName && <div className={styles.empty}>
					<div className={styles.eyebrow}><span />MORE ROOM TO THINK</div>
					<div className={styles.paperIllustration} aria-hidden="true"><div className={styles.paperBack} /><div className={styles.paperFront}><div /><div /><hr /><i /><i /><i /><i /><i /></div><span><SparklesIcon />A little clarity.</span></div>
					<h1>Keep your reading close.<br />Keep your work moving.</h1>
					<p>A quiet layer above your workspace.<br />Select a passage, start a lesson, and carry on reading.</p>
					<button type="button" className={styles.primaryButton} onClick={() => void openPdf()}><BookOpenIcon />Choose a PDF</button>
					<small>or drop a PDF here · up to 100 MB</small>
					<div className={styles.emptySteps}><span>01 <b>Read & scroll</b></span><span>02 <b>Select a passage</b></span><span>03 <b>Study in the background</b></span></div>
				</div>}
				<div ref={pages} className={styles.pages} data-testid="reader-pages" />
				{dragOver && <div className={styles.dropHint}>Drop a PDF to open it locally</div>}
			</div>
			<div className={styles.status} role="status" data-error={statusError}><span />{status}</div>
			<ReaderSessions documentName={fileName} onReveal={(targetPage) => surface.current?.navigate(targetPage)} />
			<input ref={fileInput} data-testid="reader-file-input" className={styles.hiddenFile} type="file" accept="application/pdf,.pdf" onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadFile(file); event.target.value = ""; }} />
			{menu && <div role="menu" className={styles.contextMenu} data-reader-menu data-testid="reader-context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 120) }}>
				<span>SELECTED PASSAGE</span><button role="menuitem" type="button" onClick={() => selectAction("teach")}><BookOpenIcon />Study this passage</button><button role="menuitem" type="button" onClick={() => selectAction("practice")}><DumbbellIcon />Practice this passage</button>
			</div>}
			{bubble && createPortal(<>
				{bubble.marks.map((mark, index) => <div className={styles.highlight} key={index} style={{ left: `${mark.x * 100}%`, top: `${mark.y * 100}%`, width: `${mark.width * 100}%`, height: `${mark.height * 100}%` }} />)}
				<section className={styles.studyBubble} style={bubbleStyle} aria-label="Study selected passage" data-reader-bubble data-testid="reader-study-bubble">
					<header><span><SparklesIcon />{mode === "practice" ? "Practice this passage" : "Study this passage"}</span><button type="button" aria-label="Close passage bubble" onClick={closeBubble}><XIcon /></button></header>
					<blockquote>{bubble.text.slice(0, 240)}{bubble.text.length > 240 ? "…" : ""}</blockquote>
					{started ? <div className={styles.started}><strong>{mode === "practice" ? "Practice" : "Study"} is running in the background.</strong><p>Keep reading. The session list will show when your input is needed.</p><button type="button" className={styles.primaryButton} onClick={() => void openReaderSession(started.id).catch((error: unknown) => setStudyError(messageOf(error)))}>Open session ↗</button></div>
						: <form onSubmit={(event) => void startStudy(event)}><label htmlFor="reader-question">What would you like to understand?</label><textarea id="reader-question" maxLength={2000} rows={2} placeholder="Optional: explain the idea, connect it to something, or test me…" value={question} onChange={(event) => setQuestion(event.target.value)} /><div className={styles.bubbleActions}><button type="button" aria-pressed={mode === "practice"} onClick={() => setMode(mode === "practice" ? "teach" : "practice")}><DumbbellIcon />{mode === "practice" ? "Practice mode" : "Study mode"}</button><button type="submit" className={styles.primaryButton} disabled={starting} data-testid={mode === "practice" ? "reader-start-practice" : "reader-start-study"}>{starting ? "Starting…" : mode === "practice" ? "Start practice" : "Start study"}</button></div></form>}
					{studyError && <div className={styles.studyError} role="alert">{studyError}<button type="button" onClick={() => openSettings("agent")}>Open model settings</button></div>}
					<footer>Page {bubble.page.number} · Selected text, question and source details</footer>
				</section>
			</>, bubble.page.annotations)}
			<dialog ref={passwordDialog} className={styles.passwordDialog} onCancel={(event) => { event.preventDefault(); password?.cancel(); setPassword(null); }}>
				<form onSubmit={(event) => { event.preventDefault(); password?.update(passwordValue); setPassword(null); }}><h2>Unlock this PDF</h2><p>{password?.incorrect ? "That password did not work. Try again." : "This document needs its password before you can read it."}</p><label htmlFor="reader-password">PDF password</label><input id="reader-password" type="password" required value={passwordValue} onChange={(event) => setPasswordValue(event.target.value)} autoComplete="off" /><div><button type="button" onClick={() => { password?.cancel(); setPassword(null); }}>Cancel</button><button type="submit" className={styles.primaryButton}>Unlock PDF</button></div></form>
			</dialog>
		</section>
	);
}
