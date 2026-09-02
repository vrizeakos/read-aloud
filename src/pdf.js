// Browser entry point for PDF reading. pdf.js parses the file in its own
// worker; the layout extraction and the paper analysis run here.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { extractLayout } from "./layout.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export async function readPdf(file, onProgress) {
  const data = await file.arrayBuffer();
  // Fonts are never drawn, so they are not registered with the browser.
  const task = pdfjsLib.getDocument({ data, disableFontFace: true, verbosity: 0 });
  const pdf = await task.promise;
  try {
    const pages = await extractLayout(pdf, onProgress);
    let title = file.name.replace(/\.pdf$/i, "");
    try {
      const meta = await pdf.getMetadata();
      const t = meta?.info?.Title?.trim();
      if (t && t.length > 3 && !/^untitled|\.(pdf|tex|doc)$/i.test(t)) title = t;
    } catch {
      // The file name is a fine title.
    }
    return { title, pages };
  } finally {
    // Frees the parsed document and its worker.
    task.destroy().catch(() => {});
  }
}
