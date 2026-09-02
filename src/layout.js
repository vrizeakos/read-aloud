// Pulls positioned text runs out of a pdf.js document, together with the
// font facts (bold, math, monospace) that the paper analysis relies on.
// Works in the browser and in Node, given any loaded pdf.js document.

const BOLD_RE = /bold|black|heavy|semibd|demi|cmbx|cmb\d|sfbx|-medi(?!um)/i;
const ITALIC_RE = /italic|oblique|ital\b|-it\b|cmti|cmmi|cmsl|slant|sfti|sfit/i;
const MATH_RE =
  /cmmi|cmsy|cmex|cmbsy|msam|msbm|mathematicalpi|(^|\+)symbol|rsfs|eufm|eufb|stmary|wasy|txsy|txmi|txex|pxsy|pxmi|pxex|mtsy|mtmi|mtex|math|esint|dsrom|bbold/i;
const MONO_RE = /mono|courier|cmtt|sftt|typewriter|consolas|menlo|inconsolata|nimbusmonl|luximono|beramono|lmtt|sourcecode|firacode|ubuntumono/i;
const CMR_RE = /(^|\+)cm(r|ss|bx|ti|sl|csc)\d/i;

function fontInfo(page, fontName) {
  let name = "";
  try {
    const font = page.commonObjs.get(fontName);
    name = font?.name || "";
  } catch {
    // The font was not loaded into the main thread, so only the size is known.
  }
  return {
    name,
    bold: BOLD_RE.test(name),
    italic: ITALIC_RE.test(name),
    math: MATH_RE.test(name),
    mono: MONO_RE.test(name),
    cm: CMR_RE.test(name),
  };
}

export async function extractLayout(pdf, onProgress) {
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const [vx0, vy0, vx1, vy1] = page.view;
    const content = await page.getTextContent();
    const hasText = content.items.some((it) => it.str && it.str.trim());
    if (hasText) {
      // Loading the operator list is what brings the real font names into
      // page.commonObjs. It is cheap for text pages and skipped for scans.
      try {
        await page.getOperatorList();
      } catch {
        // Font names stay unknown; everything else still works.
      }
    }
    const fonts = new Map();
    const items = [];
    for (const it of content.items) {
      if (!("str" in it) || !it.str || !it.str.trim()) continue;
      const [a, b, , , x, y] = it.transform;
      // Only upright text is kept. Rotated runs are arXiv stamps and axis labels.
      if (!(a > 0) || Math.abs(b) > a * 0.3) continue;
      const size = Math.hypot(a, b) || it.height || 0;
      if (size <= 0) continue;
      let font = fonts.get(it.fontName);
      if (!font) {
        font = fontInfo(page, it.fontName);
        fonts.set(it.fontName, font);
      }
      items.push({ str: it.str, x: x - vx0, y: y - vy0, w: it.width || 0, size, font });
    }
    pages.push({ number: i, width: vx1 - vx0, height: vy1 - vy0, items });
    page.cleanup?.();
    onProgress?.(i, pdf.numPages);
  }
  return pages;
}
