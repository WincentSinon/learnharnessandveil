import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pdfRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
const target = path.resolve(import.meta.dirname, "../public/pdf-assets");
await mkdir(target, { recursive: true });
await cp(path.join(pdfRoot, "build/pdf.worker.min.mjs"), path.join(target, "pdf.worker.min.mjs"));
for (const folder of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
	await cp(path.join(pdfRoot, folder), path.join(target, folder), { recursive: true });
}
const viewerCss = await readFile(path.join(pdfRoot, "web/pdf_viewer.css"), "utf8");
await writeFile(path.join(target, "text-layer.css"),
	"/* Mozilla PDF.js — Apache-2.0; see LICENSE.txt */\n" + viewerCss.slice(viewerCss.indexOf(".textLayer {"), viewerCss.indexOf(".textLayerImages {")));
await cp(path.join(pdfRoot, "LICENSE"), path.join(target, "LICENSE.txt"));
for (const language of ["en", "sv"]) {
	const dictionaryRoot = path.dirname(require.resolve(`dictionary-${language}`));
	for (const extension of ["aff", "dic"]) await cp(path.join(dictionaryRoot, `index.${extension}`), path.join(target, `${language}.${extension}`));
	await cp(path.join(dictionaryRoot, "license"), path.join(target, `${language}-dictionary-LICENSE.txt`));
}
console.log("Prepared local floating-reader PDF assets.");
