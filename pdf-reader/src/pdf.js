// The legacy build supports a wider range of browsers than the default one.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// Turns a page's positioned text runs into readable paragraphs.
function itemsToText(items) {
  let text = "";
  let prevY = null;
  let prevH = null;
  let prevEndX = null;

  for (const item of items) {
    if (!("str" in item) || item.str.length === 0) continue;
    const str = item.str;
    const y = item.transform[5];
    const x = item.transform[4];
    const h = item.height || prevH || 10;

    if (prevY !== null) {
      const dy = Math.abs(y - prevY);
      const sizeChanged = prevH && Math.abs(h - prevH) > 1.5;
      if (dy > Math.min(h, prevH || h) * 1.6 || (sizeChanged && dy > 0.5)) {
        text += "\n\n";
      } else if (dy > h * 0.4) {
        // New line inside a paragraph. Repair hyphenated line breaks.
        if (/[A-Za-z]-$/.test(text)) text = text.slice(0, -1);
        else text += " ";
      } else if (prevEndX !== null && x - prevEndX > h * 0.2 && !text.endsWith(" ")) {
        text += " ";
      }
    }
    text += str;
    if (item.hasEOL && !str.endsWith(" ")) text += " ";
    prevY = y;
    prevH = h;
    prevEndX = x + (item.width || 0);
  }

  return text
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractPages(file, onProgress) {
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(itemsToText(content.items));
    onProgress?.(i, pdf.numPages);
  }
  let title = file.name.replace(/\.pdf$/i, "");
  try {
    const meta = await pdf.getMetadata();
    if (meta?.info?.Title?.trim()) title = meta.info.Title.trim();
  } catch {
    /* keep filename */
  }
  return { title, pages };
}
