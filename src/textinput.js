// Builds blocks from plain text or Markdown, for documents that were cleaned
// upstream by a tool such as GROBID, Marker or Docling.

import { normalizeText } from "./paper.js";

const CAPTION_RE = /^(?:fig(?:ure)?s?\.?|tables?|tab\.|algorithms?|alg\.|listings?)\s*S?\d+[a-z]?(?:\s*[.:|—–-]|\s+[A-Z][a-z]|$)/i;
const NUMBER_RE = /^((?:\d+(?:\.\d+)*\.?)|(?:[IVXLC]+\.)|(?:[A-Z]\.(?:\d+\.?)*)|(?:appendix\s+[A-Z]))\s+(?=\S)/i;
const REFERENCES_RE = /^(?:references?|bibliography|works cited|literature cited|references and notes|citations)\s*[.:]?$/i;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…" };

function inline(s) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\$\$?([^$]+)\$\$?/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, "$1")
    .replace(/&(\w+);/g, (m, e) => ENTITIES[e] ?? m)
    .replace(/&#(\d+);/g, (m, c) => String.fromCodePoint(+c));
}

function headingParts(text) {
  const m = text.match(NUMBER_RE);
  const number = m ? m[1].trim() : "";
  const rest = (m ? text.slice(m[0].length) : text).trim().replace(/\s*[.:]$/, "");
  return { number, text: rest };
}

function joinWrapped(lines) {
  let out = "";
  for (const line of lines) {
    if (!out) {
      out = line;
      continue;
    }
    if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(line)) out = out.slice(0, -1) + line;
    else out += " " + line;
  }
  return out;
}

export function blocksFromText(raw, { markdown }) {
  const text = raw.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  const src = text.split("\n");
  const blocks = [];
  let para = [];
  let code = null;
  let math = null;
  let inRefs = false;

  const push = (b) => {
    blocks.push({ page: 1, ...b });
  };
  const flush = () => {
    if (!para.length) return;
    const t = normalizeText(joinWrapped(para));
    para = [];
    if (!t) return;
    if (CAPTION_RE.test(t)) return push({ kind: "caption", text: t });
    if (inRefs) {
      // Entries that follow each other without a blank line in between.
      for (const entry of t.split(/\s+(?=\[\d+\]\s)/)) push({ kind: "reference", text: entry.trim() });
      return;
    }
    // The line after the title, before any prose, names the authors.
    const last = blocks[blocks.length - 1];
    if (last && last.kind === "heading" && blocks.length === 1 && t.length < 160 && !/[.!?]$/.test(t)) {
      return push({ kind: "authors", text: t });
    }
    // A short, unpunctuated line standing on its own reads as a heading.
    if (t.length <= 80 && !/[.!?,;:]$/.test(t) && /^[A-Z0-9]/.test(t)) {
      const { number, text: rest } = headingParts(t);
      const known = REFERENCES_RE.test(rest);
      const titleCase = rest.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).length >= Math.ceil(rest.split(/\s+/).length / 2);
      if (number || known || (titleCase && rest.split(/\s+/).length <= 8)) {
        if (known) {
          inRefs = true;
          return push({ kind: "reference", heading: true, number, text: rest });
        }
        return push({ kind: "heading", number, text: rest });
      }
    }
    if (/^\[\d+\]\s/.test(t) && blocks.length && blocks[blocks.length - 1].kind === "reference") return push({ kind: "reference", text: t });
    push({ kind: "body", text: t });
  };

  for (const rawLine of src) {
    const line = rawLine.replace(/\s+$/, "");
    const t = line.trim();

    if (code !== null) {
      if (/^(```|~~~)/.test(t)) {
        push({ kind: "code", text: normalizeText(code.join(" ")) });
        code = null;
      } else code.push(line);
      continue;
    }
    if (math !== null) {
      if (/\$\$\s*$|^\\\]\s*$/.test(t)) {
        math.push(t.replace(/\$\$|\\\]/g, ""));
        push({ kind: "equation", text: normalizeText(math.join(" ")) });
        math = null;
      } else math.push(t);
      continue;
    }
    if (!t) {
      flush();
      continue;
    }
    if (!markdown) {
      para.push(t);
      continue;
    }

    if (/^(```|~~~)/.test(t)) {
      flush();
      code = [];
      continue;
    }
    if (/^\$\$|^\\\[/.test(t)) {
      flush();
      const inner = t.replace(/^\$\$|^\\\[/, "");
      if (/\$\$\s*$|\\\]\s*$/.test(inner) && inner.length > 2) {
        push({ kind: "equation", text: normalizeText(inner.replace(/\$\$|\\\]/g, "")) });
      } else {
        math = [inner];
      }
      continue;
    }
    const h = t.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (h) {
      flush();
      const { number, text: rest } = headingParts(normalizeText(inline(h[2])));
      if (REFERENCES_RE.test(rest)) {
        inRefs = true;
        push({ kind: "reference", heading: true, number, text: rest });
      } else {
        inRefs = false;
        push({ kind: "heading", number, text: rest });
      }
      continue;
    }
    if (/^(=+|-{3,})$/.test(t) && para.length === 1) {
      const { number, text: rest } = headingParts(normalizeText(inline(para[0])));
      para = [];
      if (REFERENCES_RE.test(rest)) {
        inRefs = true;
        push({ kind: "reference", heading: true, number, text: rest });
      } else {
        inRefs = false;
        push({ kind: "heading", number, text: rest });
      }
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flush();
      continue;
    }
    if (/^!\[[^\]]*\]\([^)]*\)\s*$/.test(t) || /^<img\b/i.test(t)) {
      flush();
      continue;
    }
    if (/^\|/.test(t) || /\S\s*\|\s*\S/.test(t)) {
      flush();
      if (/^\|?\s*:?-{2,}/.test(t)) continue;
      const cells = t
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => normalizeText(inline(c)))
        .filter(Boolean);
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "table" && last.open) last.rows.push(cells);
      else push({ kind: "table", rows: [cells], open: true, text: "" });
      continue;
    }
    if (/^\[\^[^\]]+\]:/.test(t)) {
      flush();
      push({ kind: "footnote", text: normalizeText(inline(t.replace(/^\[\^[^\]]+\]:\s*/, ""))) });
      continue;
    }
    const item = t.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (item) {
      flush();
      para.push(inline(item[1]));
      continue;
    }
    para.push(inline(t.replace(/^>\s?/, "")));
  }
  flush();
  if (code) push({ kind: "code", text: normalizeText(code.join(" ")) });
  if (math) push({ kind: "equation", text: normalizeText(math.join(" ")) });

  return blocks
    .filter((b) => b.kind === "table" || b.text)
    .map((b, i) => {
      const block = { id: i, page: 1, kind: b.kind, text: b.text, size: 10 };
      if (b.number) block.number = b.number;
      if (b.heading) block.heading = true;
      if (b.rows) {
        block.rows = b.rows;
        block.text = b.rows.map((r) => r.join(", ")).join(". ");
      }
      return block;
    });
}
