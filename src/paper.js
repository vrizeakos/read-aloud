// Turns the positioned text runs of a PDF into ordered, classified blocks so a
// research paper can be read aloud without its running headers, footers,
// tables, figure labels, footnotes and references. Plain data in, plain data
// out, so the whole pipeline can be exercised in Node against real papers.

export const DEFAULT_OPTIONS = {
  paperMode: true,
  skipReferences: true,
  skipTables: true,
  skipCaptions: true,
  skipFootnotes: true,
  skipEquations: true,
  stripCitations: true,
};

// Kinds that paper mode never reads, whatever the checkboxes say.
const ALWAYS_SKIP = new Set(["header", "footer", "pageNumber", "figure", "meta"]);
const OPTION_KINDS = {
  skipReferences: ["reference"],
  skipTables: ["table", "code"],
  skipCaptions: ["caption"],
  skipFootnotes: ["footnote"],
  skipEquations: ["equation"],
};

export const KIND_LABEL = {
  title: "Title",
  authors: "Authors",
  heading: "Heading",
  body: "Text",
  caption: "Caption",
  table: "Table",
  code: "Code",
  figure: "Figure text",
  equation: "Equation",
  footnote: "Footnote",
  header: "Header",
  footer: "Footer",
  pageNumber: "Page number",
  reference: "Reference",
  meta: "Contact details",
};

const CAPTION_RE =
  /^(?:[Ff]ig(?:ure)?s?\.?|FIG(?:URE)?S?\.?|[Tt]ables?|TABLES?|[Tt]ab\.|[Aa]lgorithms?|ALGORITHMS?|[Aa]lg\.|[Ll]istings?|[Ss]chemes?|[Cc]harts?|[Pp]lates?|[Ee]xhibits?|[Ss]upplementary [FfTt](?:igure|able))\s*S?(?:\d+[a-z]?|[IVX]+)(?:\s*[.:|—–-]|\s+[A-Z][a-z]|$)/;
const PAGE_NUMBER_RE =
  /^(?:[-–—]\s*)?(?:\d{1,4}|[ivxlcdm]{1,7}|page\s+\d+(?:\s+of\s+\d+)?|\d+\s*(?:of|\/|\|)\s*\d+)(?:\s*[-–—])?$/i;
const MATH_CHARS =
  /[=+−×÷·∑∏∫√∞∂∇≤≥≠≈≡∈∉⊂⊆⊃⊇∪∩∧∨¬→←↔⇒⇔∀∃∝∼≃≅⊗⊕‖^_{}|⟨⟩∥⊥∘∗α-ωΑ-Ω]/g;
const NUMERIC_CELL_RE = /^[\d.,%±×+\-–−()\s/]*\d[\d.,%±×+\-–−()\s/]*$/;
const BULLET_RE = /^(?:[•●○◦▪■–\-∗*·]|\(?[a-z\d]{1,2}[.)])$/;
const MARKER_RE = /^[\d∗*†‡§¶#a-z]{1,4}$/;
const HEADING_WORDS =
  /^(?:abstract|introduction|background|related works?|prior work|preliminaries|motivation|methods?|methodology|approach|(?:the )?(?:proposed )?(?:model|models|method|framework|system|architecture)|experiments?|experimental (?:setup|settings|results|evaluation)|results?|results and (?:discussion|analysis)|evaluation|analysis|discussion|conclusions?|conclusions? and future work|conclusions? and outlook|future work|limitations|limitations and future work|acknowledge?ments?|references?|bibliography|appendix|appendices|supplementary materials?|ethics statement|ethical considerations|broader impacts?|contributions?|availability|funding|data availability|conflicts? of interest|author contributions|keywords|summary|overview|notation|problem (?:statement|formulation|setup|definition)|proofs?|theory|implementation details|training details|datasets?|baselines|setup|ablation stud(?:y|ies)|ablations|case stud(?:y|ies)|qualitative results|quantitative results|main results|societal impact|reproducibility(?: statement)?)$/i;
const NUMBER_RE = /^((?:\d+(?:\.\d+)*\.?)|(?:[IVXLC]+\.)|(?:[A-Z]\.(?:\d+\.?)*)|(?:appendix\s+[A-Z]))\s+(?=\S)/i;
const REFERENCES_RE =
  /^(?:references?|bibliography|works cited|literature cited|references and notes|citations|reference list)\s*[.:]?$/i;
const ACCENTS = {
  "¨": "̈",
  "´": "́",
  "ˆ": "̂",
  "˜": "̃",
  "ˇ": "̌",
  "˘": "̆",
  "¯": "̄",
  "˚": "̊",
  "¸": "̧",
  "˙": "̇",
  "˝": "̋",
};
const ACCENT_RE = /([¨´ˆ˜ˇ˘¯˚¸˙˝])\s?([A-Za-z])/g;
const INVISIBLE_RE = /[­​‌‍﻿]/g;
const KEEP_HYPHEN = /^(?:self|non|well|cross|end-to|state-of-the)$/i;
const STOP_RE = /[.!?:;]["”’)\]]*$/;

function argmax(map, fallback) {
  let best = fallback;
  let bestN = -1;
  for (const [k, n] of map) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

function median(values) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function round2(n) {
  return Math.round(n * 2) / 2;
}

// "ABCDEF+NimbusRomNo9L-MediItal" and "NimbusRomNo9L-Regu" are one family.
function fontFamily(name) {
  return name
    .replace(/^[A-Z]{6}\+/, "")
    .toLowerCase()
    .replace(/[-,_ ]?(?:bold|italic|oblique|regular|regu|medium|medi|ital|roman|book|light|semibold|demibold|black|heavy|mt|ps|std|pro)+.*$/, "")
    .replace(/\d+$/, "");
}

// Fixes what PDF text extraction leaves behind: ligature glyphs, accents
// emitted as separate characters, odd spaces and soft hyphens.
export function normalizeText(text) {
  return text
    .replace(INVISIBLE_RE, "")
    .replace(/�/g, "")
    .replace(ACCENT_RE, (m, acc, ch) => (ch + ACCENTS[acc]).normalize("NFC"))
    .normalize("NFKC")
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Lines

function makeLine(items, stats, col = 0) {
  const sorted = items.slice().sort((a, b) => a.x - b.x);
  const bySize = new Map();
  for (const it of sorted) {
    const s = round2(it.size);
    bySize.set(s, (bySize.get(s) || 0) + it.str.trim().length);
  }
  const size = argmax(bySize, sorted[0].size);
  const main = sorted.filter((it) => Math.abs(it.size - size) < 0.6);
  const y = median((main.length ? main : sorted).map((it) => it.y));
  const byFamily = new Map();
  for (const it of main) {
    const f = fontFamily(it.font.name);
    byFamily.set(f, (byFamily.get(f) || 0) + it.str.trim().length);
  }
  const family = argmax(byFamily, "");

  let text = "";
  const cells = [];
  const cellX = [];
  let cell = "";
  let prevEnd = null;
  let prevRaw = "";
  let chars = 0;
  let bold = 0;
  let math = 0;
  let mono = 0;
  let boldEnd = false;
  let x0 = Infinity;
  let x1 = -Infinity;
  let textStart = null;
  let first = true;

  for (const it of sorted) {
    const raw = it.str;
    const str = raw.trim();
    if (!str) continue;
    x0 = Math.min(x0, it.x);
    x1 = Math.max(x1, it.x + it.w);
    const script = it.size <= 0.8 * size && Math.abs(it.y - y) > 0.15 * size;
    if (script) {
      const raised = it.y > y;
      const compact = str.replace(/\s+/g, "");
      if (raised && MARKER_RE.test(compact)) {
        // Footnote and citation markers. A power of ten keeps its exponent.
        if (/^\d+$/.test(compact) && /[\d)]$/.test(text)) {
          text += "^" + compact;
          cell += "^" + compact;
        } else if (/^\d+$/.test(compact) && /[−-]$/.test(text)) {
          text = text.slice(0, -1) + "^−" + compact;
          cell = cell.slice(0, -1) + "^−" + compact;
        }
        prevEnd = it.x + it.w;
        continue;
      }
      text += str;
      cell += str;
      prevEnd = it.x + it.w;
      continue;
    }
    if (first) {
      first = false;
      if (!BULLET_RE.test(str)) textStart = it.x;
    } else if (textStart === null) {
      textStart = it.x;
    }
    if (prevEnd !== null) {
      const gap = it.x - prevEnd;
      if (gap > 1.2 * size) {
        cells.push(cell.trim());
        cell = "";
        cellX.push(it.x);
        text += " ";
      } else if (gap > 0.12 * size || /\s$/.test(prevRaw) || /^\s/.test(raw)) {
        text += " ";
        cell += " ";
      }
    } else {
      cellX.push(it.x);
    }
    text += str;
    cell += str;
    prevRaw = raw;
    prevEnd = it.x + it.w;
    const n = str.length;
    chars += n;
    if (it.font.bold) bold += n;
    boldEnd = !!it.font.bold;
    if (it.font.math || (it.font.cm && !stats.cmBody)) math += n;
    if (it.font.mono) mono += n;
  }
  if (cell.trim()) cells.push(cell.trim());
  text = text.replace(/\s+/g, " ").trim();
  if (textStart === null) textStart = x0;

  const nonSpace = text.replace(/\s/g, "").length || 1;
  const ops = (text.match(MATH_CHARS) || []).length;
  const singles = (text.match(/(?:^|[\s(])[b-zB-HJ-Z](?=$|[\s,.;:)])/g) || []).length;
  const mathScore = (math + ops + singles) / nonSpace;
  const numeric = cells.filter((c) => NUMERIC_CELL_RE.test(c)).length;
  const avgCell = cells.length ? cells.reduce((s, c) => s + c.length, 0) / cells.length : 0;
  const eqNumber = cells.length >= 2 && /\(\d+[a-z]?\)$/.test(text);
  const tabular =
    !eqNumber && ((cells.length >= 3 && (numeric / cells.length >= 0.3 || avgCell <= 12)) || cells.length >= 4);
  // Rows of bare numbers separated by ordinary spaces, as in results tables.
  const tokens = text.split(/\s+/).filter(Boolean);
  const bare = tokens.filter((t) => /^(?:[\d.]*\d[\d.]*%?|[-–])$/.test(t)).length;
  const numericRow = !eqNumber && bare >= 3 && bare >= 0.4 * tokens.length && !/[.!?]$/.test(text);
  const isMath = mathScore >= 0.45 || (eqNumber && mathScore >= 0.15);
  const bullet = /^[•●○◦▪■]\s/.test(text) || (sorted.length > 1 && BULLET_RE.test(sorted[0].str.trim()));

  return {
    items: sorted,
    col,
    y,
    x0,
    x1,
    size,
    family,
    text,
    cells,
    cellX,
    textStart,
    bullet,
    chars,
    bold: chars > 0 && bold / chars >= 0.8,
    boldEnd,
    mono: chars > 0 && mono / chars >= 0.7,
    math: isMath,
    mathScore,
    eqNumber,
    tabular,
    numericRow,
    capStart: CAPTION_RE.test(text),
    pageNumber: PAGE_NUMBER_RE.test(text),
  };
}

// Groups runs that share a baseline. Superscripts and subscripts fall inside
// the tolerance and join the line of the text they belong to; two large runs
// of clearly different sizes never share a line.
function groupByBaseline(items, bodySize) {
  const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const groups = [];
  for (const it of sorted) {
    let best = null;
    let bestD = Infinity;
    for (let k = groups.length - 1; k >= 0 && k >= groups.length - 10; k--) {
      const G = groups[k];
      const lo = Math.min(G.size, it.size);
      const hi = Math.max(G.size, it.size);
      if (lo >= 0.9 * bodySize && lo / hi < 0.8) continue;
      const small = lo < 0.8 * hi;
      const tol = 0.45 * hi + (small ? 0.15 * hi : 0);
      const d = Math.abs(G.y - it.y);
      if (d > tol || d >= bestD) continue;
      // A small run that sits on top of existing text is a label from a
      // figure above or below, not a superscript.
      if (small && G.items.some((o) => it.x < o.x + o.w - 1 && it.x + it.w > o.x + 1)) continue;
      best = G;
      bestD = d;
    }
    if (!best) {
      best = { y: it.y, size: it.size, items: [] };
      groups.push(best);
    }
    best.items.push(it);
    if (it.size > best.size + 0.5) {
      best.size = it.size;
      best.y = it.y;
    }
  }
  return groups.map((g) => g.items);
}

// Detects a two column layout and returns the lines in reading order:
// full width lines split the page into bands, and inside a band the left
// column is read before the right one.
function orderLines(groups, stats) {
  const lines = groups.map((g) => makeLine(g, stats));
  const prose = lines.filter((l) => l.size >= 0.8 * stats.bodySize && !l.tabular && l.chars >= 3);
  const single = () => ({ lines: lines.map((l) => ({ ...l, col: 0 })), info: { two: false } });
  if (prose.length < 6) return single();

  const xs0 = prose.map((l) => l.x0).sort((a, b) => a - b);
  const xs1 = prose.map((l) => l.x1).sort((a, b) => a - b);
  const left = xs0[Math.floor(xs0.length * 0.05)];
  const right = xs1[Math.floor(xs1.length * 0.95)];
  const g = 0.5 * stats.bodySize;
  let best = null;
  for (let c = left + (right - left) * 0.35; c <= left + (right - left) * 0.65; c += 2) {
    let overlap = 0;
    let l = 0;
    let r = 0;
    let leftLines = 0;
    let rightLines = 0;
    for (const line of prose) {
      let lineL = 0;
      let lineR = 0;
      let lineO = 0;
      for (const it of line.items) {
        if (round2(it.size) < 0.8 * stats.bodySize) continue;
        const n = it.str.trim().length;
        if (it.x + it.w <= c - g) lineL += n;
        else if (it.x >= c + g) lineR += n;
        else lineO += n;
      }
      l += lineL;
      r += lineR;
      overlap += lineO;
      if (lineL && !lineO) leftLines++;
      if (lineR && !lineO) rightLines++;
    }
    if (!best || overlap < best.overlap) best = { c, overlap, l, r, leftLines, rightLines };
  }
  const total = best.l + best.r + best.overlap || 1;
  const two = best.leftLines >= 3 && best.rightLines >= 3 && best.overlap <= 0.25 * total;
  const info = { two, c: Math.round(best.c), leftLines: best.leftLines, rightLines: best.rightLines, overlap: Math.round((100 * best.overlap) / total) };
  if (!two) return { lines: lines.map((l) => ({ ...l, col: 0 })), info };

  const overlaps = (line) =>
    line.items.some(
      (it) => round2(it.size) >= 0.8 * stats.bodySize && it.x < best.c + g && it.x + it.w > best.c - g,
    );
  const out = [];
  let band = { left: [], right: [] };
  const flush = () => {
    out.push(...band.left, ...band.right);
    band = { left: [], right: [] };
  };
  let prevSpanning = false;
  let prevLine = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const L = line.items.filter((it) => it.x + it.w / 2 < best.c);
    const R = line.items.filter((it) => it.x + it.w / 2 >= best.c);
    let spanning = overlaps(line);
    if (!spanning && prevSpanning && L.length && R.length) {
      // A lone line with text on both sides between two full width lines,
      // such as a row of author names, belongs to the full width flow.
      const next = lines[i + 1];
      if (!next || overlaps(next)) spanning = true;
    }
    if (!spanning && prevSpanning && L.length && !R.length && prevLine) {
      // The short last line of a full width paragraph.
      const pitch = stats.pitch * (line.size / stats.bodySize);
      if (
        !prevLine.tabular &&
        prevLine.chars >= 20 &&
        Math.abs(prevLine.size - line.size) < 0.6 &&
        prevLine.y - line.y < 1.5 * pitch &&
        !STOP_RE.test(prevLine.text)
      ) {
        spanning = true;
      }
    }
    if (spanning) {
      flush();
      out.push({ ...line, col: -1 });
    } else {
      if (L.length) band.left.push(makeLine(L, stats, 0));
      if (R.length) band.right.push(makeLine(R, stats, 1));
    }
    prevSpanning = spanning;
    prevLine = line;
  }
  flush();
  return { lines: out, info };
}

// Small runs that ended up on their own line (a superscript pulled towards a
// neighbouring column, a stray footnote marker) rejoin the nearest line.
function absorbOrphans(lines, stats) {
  const drop = new Set();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.size >= 0.8 * stats.bodySize || l.chars > 6) continue;
    let target = -1;
    for (const j of [i + 1, i - 1]) {
      const m = lines[j];
      if (!m || drop.has(j) || m.col !== l.col || m.size <= l.size) continue;
      if (Math.abs(m.y - l.y) <= 0.6 * m.size) {
        target = j;
        break;
      }
    }
    if (target >= 0) {
      lines[target] = makeLine([...lines[target].items, ...l.items], stats, l.col);
      drop.add(i);
    } else if (/^[\d∗*†‡§¶]+$/.test(l.text.replace(/\s/g, ""))) {
      drop.add(i);
    }
  }
  return lines.filter((_, i) => !drop.has(i));
}

// ---------------------------------------------------------------------------
// Blocks

function columnBounds(lines, stats) {
  const bounds = new Map();
  for (const col of new Set(lines.map((l) => l.col))) {
    const own = lines.filter((l) => l.col === col && l.size >= 0.8 * stats.bodySize);
    const use = own.length ? own : lines.filter((l) => l.col === col);
    const starts = new Map();
    for (const l of use) {
      const k = Math.round(l.x0);
      starts.set(k, (starts.get(k) || 0) + 1);
    }
    const xs1 = use.map((l) => l.x1).sort((a, b) => a - b);
    bounds.set(col, {
      left: argmax(starts, Math.round(use[0].x0)),
      right: xs1[Math.min(xs1.length - 1, Math.floor(xs1.length * 0.95))],
    });
  }
  return bounds;
}

function alignedCells(a, b, size) {
  let n = 0;
  for (const x of a.cellX) if (b.cellX.some((y) => Math.abs(x - y) <= 0.6 * size)) n++;
  return n;
}

function buildBlocks(lines, stats, page) {
  const bounds = columnBounds(lines, stats);

  // Two cell rows count as table rows when their cells line up with a
  // neighbouring row, which catches table headers and two column tables.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.tabular && line.numericRow) {
      const b = bounds.get(line.col);
      if (line.size < 0.95 * stats.bodySize || line.x1 - line.x0 < 0.9 * Math.max(b.right - b.left, 1)) {
        line.tabular = true;
      }
    }
    if (line.tabular || line.cells.length < 2) continue;
    for (const j of [i - 1, i + 1]) {
      const other = lines[j];
      if (!other || other.col !== line.col || other.cells.length < 2) continue;
      const pitch = stats.pitch * (line.size / stats.bodySize);
      if (Math.abs(other.y - line.y) > 1.8 * pitch) continue;
      if (alignedCells(line, other, Math.max(line.size, other.size)) >= 2) {
        line.tabular = true;
        break;
      }
    }
  }

  // Display equations sit apart from the text; a math heavy line that runs
  // the full width, or continues the previous line, is prose.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const b = bounds.get(line.col);
    const width = line.x1 - line.x0;
    const colW = Math.max(b.right - b.left, 1);
    const flush = line.x0 <= b.left + 0.5 * line.size;
    let eq = line.math && (line.eqNumber || (!flush && width < 0.85 * colW) || line.mathScore >= 0.85);
    const prev = lines[i - 1];
    if (eq && !line.eqNumber && flush && prev && prev.col === line.col && !prev.eq && !STOP_RE.test(prev.text)) {
      eq = false;
    }
    line.eq = eq;
  }

  const blocks = [];
  let cur = null;
  for (const line of lines) {
    let start = !cur;
    if (cur) {
      const prev = cur.lines[cur.lines.length - 1];
      const size = Math.max(line.size, prev.size);
      const gap = prev.y - line.y;
      const pitch = Math.max(stats.pitch * (size / stats.bodySize), size);
      const colW = Math.max(cur.right - cur.left, 1);
      const centered =
        Math.abs((line.x0 + line.x1) / 2 - (cur.left + cur.right) / 2) < 1.5 * size && line.x1 - line.x0 < 0.7 * colW;
      const indent = line.x0 - cur.left;
      const hanging =
        cur.lines.length >= 2 &&
        cur.lines.slice(1).every((l) => l.x0 > cur.lines[0].x0 + 0.5 * size) &&
        line.x0 <= cur.lines[0].x0 + 0.3 * size;
      if (line.col !== prev.col) start = true;
      else if (gap < -0.5 * size) start = true;
      else if (gap > 1.6 * pitch) start = true;
      else if (Math.abs(line.size - prev.size) > 0.75) start = true;
      else if (line.family !== prev.family && !line.mono && !prev.mono && line.chars > 3 && prev.chars > 3) start = true;
      else if (line.bold !== prev.bold && line.chars > 2 && prev.chars > 2) start = true;
      else if (line.tabular !== prev.tabular) start = true;
      else if (line.eq !== prev.eq) start = true;
      else if (line.capStart && STOP_RE.test(prev.text)) start = true;
      else if (/^\[\d+\]/.test(line.text) && !/^\[\d+\]/.test(prev.text)) start = true;
      else if (/^\d{1,3}\.\s+[A-Z]/.test(line.text) && line.size < 0.95 * stats.bodySize && /[.!?]$/.test(prev.text)) {
        start = true;
      } else if (
        !centered &&
        indent > 0.5 * size &&
        indent < 4.5 * size &&
        line.x0 - prev.textStart > 0.5 * size &&
        !(prev.bullet && line.x0 - prev.x0 <= 2 * size)
      ) {
        start = true;
      } else if (hanging) start = true;
      else if (prev.x1 < cur.right - 3 * size && /[.!?:]["”’)\]]*$/.test(prev.text) && /^[A-Z0-9“"(\[]/.test(line.text)) {
        start = true;
      }
    }
    if (start) {
      const b = bounds.get(line.col);
      cur = { page: page.number, col: line.col, lines: [line], left: b.left, right: b.right };
      blocks.push(cur);
    } else {
      cur.lines.push(line);
    }
  }
  return blocks;
}

function joinLines(lines) {
  let out = "";
  for (const line of lines) {
    const t = line.text;
    if (!t) continue;
    if (!out) {
      out = t;
      continue;
    }
    const m = out.match(/([A-Za-z-]+)-$/);
    if (m && /^[a-z]/.test(t)) {
      out = KEEP_HYPHEN.test(m[1]) ? out + t : out.slice(0, -1) + t;
    } else if (/\d-$/.test(out) && /^[a-z]/.test(t)) {
      out += t;
    } else {
      out += " " + t;
    }
  }
  return out;
}

function dominantSize(block) {
  const bySize = new Map();
  for (const l of block.lines) bySize.set(round2(l.size), (bySize.get(round2(l.size)) || 0) + l.chars);
  return argmax(bySize, block.lines[0].size);
}

function dominantFamily(block) {
  const byFamily = new Map();
  for (const l of block.lines) byFamily.set(l.family, (byFamily.get(l.family) || 0) + l.chars);
  return argmax(byFamily, "");
}

function normalizeForRepeat(text) {
  return text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

function looksLikeHeading(block, stats, strict) {
  if (block.lines.length > 3) return null;
  if (block.lines.some((l) => l.tabular || l.eq)) return null;
  const text = block.text.replace(/\s+/g, " ").trim();
  if (text.length < 2 || text.length > 120) return null;
  const ratio = block.size / stats.bodySize;
  const bold = block.lines.every((l) => l.bold && l.boldEnd);
  const m = text.match(NUMBER_RE);
  const number = m ? m[1].replace(/\s+/g, " ").trim() : "";
  const rest = (m ? text.slice(m[0].length) : text).trim();
  const words = rest.split(/\s+/).length;
  const known = HEADING_WORDS.test(rest.replace(/[.:]$/, "").trim());
  const allCaps = /^[^a-z]*$/.test(rest) && /[A-Z]{3}/.test(rest) && !/\d/.test(rest);
  const capitalized = /^[A-Z0-9“"(]/.test(rest);
  if (!capitalized && !allCaps) return null;
  if (/[.!?]$/.test(rest) && words > 6) return null;
  if (/[.!?]\s+[A-Z(]/.test(rest) && words > 4) return null;
  if (/[,;]$/.test(rest)) return null;
  if (strict) {
    if (!(known || (number && (bold || ratio >= 1.1)))) return null;
  } else {
    const styled = bold || ratio >= 1.12 || allCaps;
    if (!styled) return null;
    const shortBold = bold && words <= 8;
    if (!(known || number || ratio >= 1.12 || allCaps || shortBold)) return null;
    if (!number && !known && !allCaps && words > 12) return null;
  }
  return { number, text: rest.replace(/\s*[.:]$/, ""), known };
}

function classifyPage(blocks, page, stats, ctx) {
  const H = page.height;
  const topZone = H * 0.925;
  const bottomZone = H * 0.075;
  const bodyBottom = new Map();
  for (const b of blocks) {
    b.text = joinLines(b.lines);
    b.size = dominantSize(b);
    b.family = dominantFamily(b);
    for (const l of b.lines) {
      if (l.size >= 0.95 * stats.bodySize && l.y > bottomZone && l.chars > 20) {
        const m = bodyBottom.get(b.col);
        if (m === undefined || l.y < m) bodyBottom.set(b.col, l.y);
      }
    }
  }
  let maxTop = 0;
  if (page.number === 1) {
    for (const b of blocks) if (b.lines[0].y > H * 0.45) maxTop = Math.max(maxTop, b.size);
  }
  let afterTitle = false;
  let authorsDone = false;
  let prevBlock = null;

  for (const b of blocks) {
    const first = b.lines[0];
    const last = b.lines[b.lines.length - 1];
    const text = b.text;
    const ratio = b.size / stats.bodySize;
    const inTop = last.y > topZone;
    const inBottom = first.y < bottomZone;
    const key = normalizeForRepeat(text);
    const shortLabel = b.lines.length <= 2 && text.length < 60 && !/[.!?]$/.test(text);
    // Body text that carries on from an unfinished paragraph cannot be a
    // caption or a heading, however its first words look.
    const continuation =
      prevBlock &&
      prevBlock.kind === "body" &&
      !STOP_RE.test(prevBlock.text) &&
      (prevBlock.lines.length >= 2 ||
        (prevBlock.lines[0].cells.length === 1 &&
          prevBlock.lines[0].x1 - prevBlock.lines[0].x0 > 0.5 * Math.max(prevBlock.right - prevBlock.left, 1))) &&
      ratio >= 0.97 &&
      Math.abs(prevBlock.size - b.size) < 0.6 &&
      !first.tabular &&
      !first.eq;
    prevBlock = b;

    if (inTop || inBottom) {
      if (b.lines.length <= 2 && PAGE_NUMBER_RE.test(text)) {
        b.kind = "pageNumber";
        continue;
      }
      if (ctx.repeated.has(key) || ratio < 0.95 || text.length < 60 || b.lines.length <= 2) {
        b.kind = inTop ? "header" : "footer";
        continue;
      }
    }
    if ((last.y > H * 0.86 || first.y < H * 0.14) && b.lines.length <= 2 && ctx.repeated.has(key) && ratio >= 0.8) {
      b.kind = last.y > H * 0.86 ? "header" : "footer";
      continue;
    }
    if (
      page.number === 1 &&
      !ctx.titleFound &&
      ratio >= 1.15 &&
      b.lines.length <= 4 &&
      first.y > H * 0.45 &&
      b.size >= maxTop - 0.5
    ) {
      b.kind = "title";
      b.text = text.replace(/\s*[.]$/, "");
      ctx.titleFound = true;
      afterTitle = true;
      continue;
    }
    if (afterTitle && !authorsDone) {
      const heading = looksLikeHeading(b, stats, true);
      const longBody = b.lines.length >= 3 && text.length > 120 && ratio >= 0.9 && ratio <= 1.1 && !first.bold;
      if (heading || longBody) authorsDone = true;
      else {
        b.kind = /@|https?:\/\/|www\./i.test(text) ? "meta" : "authors";
        b.rows = b.lines.map((l) => l.cells.map((c) => c.replace(/[∗*†‡§¶]+/g, "").trim()).filter(Boolean));
        b.text = text.replace(/[∗*†‡§¶]+/g, "");
        continue;
      }
    }
    if (first.capStart && !continuation) {
      b.kind = "caption";
      b.captionType = /^tab/i.test(text) ? "table" : "figure";
      continue;
    }
    const heading = continuation ? null : looksLikeHeading(b, stats, false);
    if (heading) {
      b.kind = "heading";
      b.number = heading.number;
      b.text = heading.text;
      b.known = heading.known;
      if (REFERENCES_RE.test(heading.text)) {
        b.kind = "reference";
        b.heading = true;
        ctx.inReferences = true;
      } else {
        ctx.inReferences = false;
      }
      continue;
    }
    if (ctx.inReferences) {
      b.kind = "reference";
      continue;
    }
    const tabularLines = b.lines.filter((l) => l.tabular).length;
    if (tabularLines >= 1 && tabularLines >= b.lines.length * 0.5) {
      b.kind = ratio < 0.75 ? "figure" : "table";
      b.rows = b.lines.map((l) => l.cells);
      continue;
    }
    const eqLines = b.lines.filter((l) => l.eq).length;
    if (eqLines >= b.lines.length * 0.5) {
      b.kind = ratio < 0.75 ? "figure" : "equation";
      continue;
    }
    if (ratio < 0.75) {
      b.kind = "figure";
      continue;
    }
    if (ratio < 0.93) {
      const bottom = bodyBottom.get(b.col);
      if (bottom !== undefined && first.y < bottom) {
        b.kind = "footnote";
        continue;
      }
      if (text.length < 40 && b.lines.length <= 4 && !/[.!?]$/.test(text)) {
        b.kind = "figure";
        continue;
      }
    }
    if (b.lines.length >= 2 && b.lines.every((l) => l.mono)) {
      b.kind = "code";
      continue;
    }
    if (b.family && b.family !== stats.bodyFamily && shortLabel && !first.bold) {
      b.kind = "figure";
      continue;
    }
    if (b.lines.length <= 2 && /\S+@\S+\.\S+/.test(text)) {
      b.kind = "meta";
      continue;
    }
    b.kind = "body";
  }

  // Labels inside figures and tables come in the body font too. Short,
  // unpunctuated blocks sitting in a run of figure or table fragments are
  // fragments themselves.
  const floaty = (b) => b.kind === "figure" || b.kind === "table" || (b.kind === "equation" && b.size < 0.9 * stats.bodySize);
  const soft = (b) =>
    (b.kind === "body" || b.kind === "heading" || b.kind === "equation") &&
    b.lines.length <= 2 &&
    b.text.length < 60 &&
    b.text.split(/\s+/).length <= 6 &&
    !/[.!?]$/.test(b.text) &&
    !/[.!?]\s/.test(b.text) &&
    !(b.kind === "heading" && (b.number || b.known));
  // Small print without a full stop, such as multi level table headers.
  const softTable = (b) =>
    (b.kind === "body" || b.kind === "heading" || b.kind === "footnote") &&
    b.size < 0.93 * stats.bodySize &&
    b.lines.length <= 3 &&
    b.text.split(/\s+/).length <= 14 &&
    !/[.!?]$/.test(b.text);
  const softish = (b) => soft(b) || softTable(b);
  const textual = (b) => b && (b.kind === "body" || b.kind === "heading" || b.kind === "reference");
  const relabel = (b, kind) => {
    b.kind = kind;
    if (kind === "table" && !b.rows) b.rows = b.lines.map((l) => l.cells);
  };
  let i = 0;
  while (i < blocks.length) {
    if (!floaty(blocks[i]) && !softish(blocks[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < blocks.length && (floaty(blocks[j]) || softish(blocks[j]))) j++;
    const run = blocks.slice(i, j);
    const nFloaty = run.filter(floaty).length;
    const nSoft = run.length - nFloaty;
    const capBefore = blocks[i - 1]?.kind === "caption";
    const capAfter = blocks[j]?.kind === "caption";
    if (nFloaty >= 2 && nFloaty >= nSoft) {
      const asTable = run.some((b) => b.kind === "table");
      run.forEach((b, k) => {
        if (!softish(b)) return;
        // A label at the edge of the run next to real text is more likely
        // the first or last line of a paragraph than part of the figure.
        if (k === 0 && !capBefore && textual(blocks[i - 1])) return;
        if (k === run.length - 1 && !capAfter && textual(blocks[j])) return;
        relabel(b, asTable ? "table" : "figure");
      });
    } else if (cap(capBefore, capAfter) && nFloaty === 0) {
      // Labels drawn in a different font, or spread out in cells, that lead
      // up to a caption belong to the figure.
      const type = capAfter ? blocks[j].captionType : blocks[i - 1].captionType;
      for (const b of run) {
        if (b.family !== stats.bodyFamily || b.lines.some((l) => l.cells.length >= 2)) relabel(b, type);
      }
    }
    // The caption next to a run says what the run is.
    const capBlock = capAfter ? blocks[j] : capBefore ? blocks[i - 1] : null;
    if (capBlock && nFloaty >= 1) {
      for (const b of run) {
        if (floaty(b)) relabel(b, capBlock.captionType);
      }
    }
    i = j;
  }
}

function cap(before, after) {
  return before || after;
}

// Paragraphs that run across a column or page break, or around a figure, are
// stitched back together so that sentences are not cut in half.
function mergeContinuations(blocks) {
  const FLOAT = new Set(["figure", "caption", "table", "footnote", "header", "footer", "pageNumber", "meta", "code"]);
  const out = [];
  let lastText = -1;
  const continues = (p, b) => {
    const pt = p.text.trimEnd();
    const bt = b.text.trimStart();
    if (Math.abs(p.size - b.size) > 0.75) return false;
    if (b.kind === "reference" && /^\[\d+\]|^\d{1,3}\.\s/.test(bt)) return false;
    if (b.lines[0].x0 - b.left > 0.5 * b.size) return false;
    const pl = p.lines[p.lines.length - 1];
    const wide = pl.x1 - pl.x0 > 0.5 * Math.max(p.right - p.left, 1);
    if (p.lines.length < 2 && (!wide || pl.cells.length > 1)) return false;
    if (/[A-Za-z]-$/.test(pt)) return true;
    return !STOP_RE.test(pt);
  };
  for (const b of blocks) {
    if ((b.kind === "body" || b.kind === "reference") && lastText >= 0) {
      const p = out[lastText];
      const between = out.slice(lastText + 1);
      if (p.kind === b.kind && between.every((x) => FLOAT.has(x.kind)) && continues(p, b)) {
        p.lines.push(...b.lines);
        p.text = joinLines(p.lines);
        continue;
      }
    }
    out.push(b);
    if (b.kind === "body" || b.kind === "reference") lastText = out.length - 1;
    else if (!FLOAT.has(b.kind)) lastText = -1;
  }
  return out;
}

function documentStats(pages) {
  const sizeChars = new Map();
  const fontChars = new Map();
  for (const p of pages) {
    for (const it of p.items) {
      const n = it.str.trim().length;
      if (!n) continue;
      sizeChars.set(round2(it.size), (sizeChars.get(round2(it.size)) || 0) + n);
      fontChars.set(it.font.name, (fontChars.get(it.font.name) || 0) + n);
    }
  }
  const bodySize = argmax(sizeChars, 10);
  const bodyFont = argmax(fontChars, "");
  return {
    bodySize,
    bodyFamily: fontFamily(bodyFont),
    cmBody: /(^|\+)cm(r|ss|bx|ti|sl)\d/i.test(bodyFont),
    pitch: bodySize * 1.2,
  };
}

function measurePitch(pagesLines, stats) {
  const gaps = [];
  for (const lines of pagesLines) {
    for (let i = 1; i < lines.length; i++) {
      const a = lines[i - 1];
      const b = lines[i];
      if (a.col !== b.col) continue;
      if (Math.abs(a.size - stats.bodySize) > 0.6 || Math.abs(b.size - stats.bodySize) > 0.6) continue;
      const gap = a.y - b.y;
      if (gap > 0.8 * stats.bodySize && gap < 2.5 * stats.bodySize) gaps.push(gap);
    }
  }
  return gaps.length >= 5 ? median(gaps) : stats.bodySize * 1.2;
}

export function analyzeLayout(pages) {
  const stats = documentStats(pages);
  const ordered = pages.map((p) => orderLines(groupByBaseline(p.items, stats.bodySize), stats));
  stats.columns = ordered.map((o) => o.info);
  const pagesLines = ordered.map((o) => absorbOrphans(o.lines, stats));
  stats.pitch = measurePitch(pagesLines, stats);

  // Text that repeats near the top or bottom of several pages is a running
  // header or footer.
  const seen = new Map();
  pages.forEach((p, i) => {
    const keys = new Set();
    for (const l of pagesLines[i]) {
      if (l.y > p.height * 0.86 || l.y < p.height * 0.14) keys.add(normalizeForRepeat(l.text));
    }
    for (const k of keys) seen.set(k, (seen.get(k) || 0) + 1);
  });
  const need = Math.max(2, Math.ceil(pages.length * 0.3));
  const repeated = new Set([...seen].filter(([k, n]) => n >= need && k.length > 0).map(([k]) => k));

  const ctx = { repeated, titleFound: false, inReferences: false };
  let blocks = [];
  pages.forEach((p, i) => {
    const pageBlocks = buildBlocks(pagesLines[i], stats, p);
    classifyPage(pageBlocks, p, stats, ctx);
    blocks.push(...pageBlocks);
  });

  // Reference lists without a recognisable heading: a long run of small
  // "[n]" entries.
  let run = [];
  const flushRun = () => {
    if (run.length >= 6) for (const b of run) b.kind = "reference";
    run = [];
  };
  for (const b of blocks) {
    if ((b.kind === "body" || b.kind === "footnote") && /^\[\d+\]\s/.test(b.text) && b.size < 0.97 * stats.bodySize) {
      run.push(b);
    } else if (b.kind !== "pageNumber" && b.kind !== "header" && b.kind !== "footer") {
      flushRun();
    }
  }
  flushRun();

  blocks = mergeContinuations(blocks);

  // Specks of small text with nothing to say are dropped outright.
  blocks = blocks.filter((b) => !(b.size < 0.8 * stats.bodySize && b.text.replace(/[^\p{L}\p{N}]/gu, "").length <= 2));

  const out = blocks.map((b, i) => {
    const block = {
      id: i,
      page: b.page,
      kind: b.kind,
      text: normalizeText(b.text),
      size: b.size,
    };
    if (b.number) block.number = b.number;
    if (b.heading) block.heading = true;
    if (b.rows) block.rows = b.rows.map((r) => r.map(normalizeText).filter(Boolean)).filter((r) => r.length);
    return block;
  });
  return { blocks: out, stats };
}

// ---------------------------------------------------------------------------
// Speech text

const YEAR = "(?:1[6-9]|20)\\d{2}[a-z]?";
const CITATION_SEGMENT = new RegExp(
  `^(?:(?:e\\.g\\.|i\\.e\\.|see|cf\\.|see also|also|for example|and|as in|following|after|inter alia|in)[,\\s]+)*(?:[A-Z][^,;]*?[,\\s]+)?${YEAR}(?:\\s*[,;]?\\s*${YEAR})*(?:[,\\s]+(?:p+\\.|chap\\.|ch\\.|§|sec\\.)?\\s*\\d+(?:[-–]\\d+)?)?\\s*$`,
);

function isCitation(inner) {
  const segments = inner
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  return segments.length > 0 && segments.every((s) => CITATION_SEGMENT.test(s));
}

export function stripCitations(text) {
  return text
    .replace(/\s?\[\s*\d{1,3}(?:\s*[,;–\-]\s*\d{1,3})*\s*\]/g, "")
    .replace(/\s?\(([^()]{2,200})\)/g, (m, inner) => (isCitation(inner) ? "" : m));
}

const SPEECH_RULES = [
  [/\bFigs\.\s*(?=\d)/g, "Figures "],
  [/\bFig\.\s*(?=\d)/g, "Figure "],
  [/\bEqs\.\s*(?=\(?\d)/g, "Equations "],
  [/\bEq\.\s*(?=\(?\d)/g, "Equation "],
  [/\bEqn\.\s*(?=\(?\d)/g, "Equation "],
  [/\bSecs\.\s*(?=\d)/g, "Sections "],
  [/\bSec\.\s*(?=\d)/g, "Section "],
  [/\bTab\.\s*(?=\d)/g, "Table "],
  [/\bRefs\.\s*(?=\d|\[)/g, "References "],
  [/\bRef\.\s*(?=\d|\[)/g, "Reference "],
  [/\bAlg\.\s*(?=\d)/g, "Algorithm "],
  [/\bAppx\.\s*(?=[A-Z\d])/g, "Appendix "],
  [/\be\.g\.,?/g, "for example,"],
  [/\bi\.e\.,?/g, "that is,"],
  [/\bcf\.\s/g, "compare "],
  [/\bvs\.?\s/g, "versus "],
  [/\bw\.r\.t\.\s/g, "with respect to "],
  [/\bapprox\.\s/g, "approximately "],
  [/\bet al\.(?=\s+[a-z(,;])/g, "et al"],
  [/×/g, " times "],
  [/±/g, " plus or minus "],
  [/≈/g, " approximately "],
  [/≤/g, " at most "],
  [/≥/g, " at least "],
  [/→/g, " to "],
  [/(^|\s)[∼~](?=\d)/g, "$1about "],
  [/%/g, " percent"],
  [/°/g, " degrees"],
  [/\s&\s/g, " and "],
  [/\^−(\d+)/g, " to the power of minus $1"],
  [/\^(\d+)/g, " to the power of $1"],
  [/−(?=\d)/g, "minus "],
  [/\s−\s/g, " minus "],
  [/(?<=\d)[–−](?=\d)/g, "-"],
  [/[•●■◆▪]/g, ""],
];

export function cleanForSpeech(text, options) {
  let t = text;
  if (options.stripCitations) t = stripCitations(t);
  for (const [re, rep] of SPEECH_RULES) t = t.replace(re, rep);
  return t
    .replace(/\(\s*\)/g, "")
    .replace(/\[\s*\]/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:])\s*(?=[,;:])/g, "")
    .replace(/\(\s*,\s*/g, "(")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function ensureStop(text) {
  return /[.!?…:]$/.test(text) ? text : text + ".";
}

export function speechFor(block, options) {
  let t;
  switch (block.kind) {
    case "title":
    case "heading":
    case "caption":
      t = ensureStop(block.text);
      break;
    case "reference":
      t = block.heading ? ensureStop(block.text) : block.text.replace(/^\[\d+\]\s*/, "");
      break;
    case "authors":
    case "table":
      t = block.rows ? block.rows.map((r) => r.join(", ")).join(". ") : block.text;
      t = ensureStop(t);
      break;
    case "footnote":
      t = block.text.replace(/^[\d∗*†‡§¶]+\s*/, "");
      break;
    default:
      t = block.text;
  }
  return cleanForSpeech(t, options);
}

export function defaultIncluded(block, options) {
  if (!options.paperMode) return true;
  if (ALWAYS_SKIP.has(block.kind)) return false;
  for (const [opt, kinds] of Object.entries(OPTION_KINDS)) {
    if (options[opt] && kinds.includes(block.kind)) return false;
  }
  return true;
}

// Resolves which blocks are read, honouring the user's per block choices,
// and prepares the text the voice will speak.
export function applyOptions(blocks, options, overrides) {
  return blocks.map((b) => {
    const auto = defaultIncluded(b, options);
    const included = overrides.has(b.id) ? overrides.get(b.id) : auto;
    return {
      ...b,
      included,
      auto,
      speech: included ? speechFor(b, options) : "",
    };
  });
}
