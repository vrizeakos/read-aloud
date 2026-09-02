// Sentence splitting tuned for academic prose. Runs on the main thread so the
// document view and the voice always agree on what a "sentence" is.

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "mt", "etc", "co", "inc", "ltd", "dept", "vs", "p", "pg", "pp",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "fig", "figs", "eq", "eqs", "sec", "secs", "ref", "refs", "tab", "no", "nos", "vol", "vols", "approx", "al", "cf",
  "resp", "ca", "ch", "chap", "def", "prop", "thm", "lem", "cor", "fn", "univ", "inst", "proc", "conf", "ed", "eds",
  "trans", "rev", "et", "ph.d", "ph", "min", "max", "std", "avg", "est", "ver", "tech", "rep", "int", "eng", "sci",
  "phys", "chem", "biol", "comput", "appl", "assoc", "soc", "ann", "natl", "acad", "viz", "op", "ibid", "i.e", "e.g",
  "w.r.t", "a.k.a", "u.s", "u.k", "seq", "sqrt", "alg", "appx", "ex", "misc", "vs", "cont", "approx",
]);
const TERMINAL = ".!?…";
const CLOSERS = "\"'’”)]}";
const MAX_CHUNK = 380;

export function splitSentences(text) {
  const out = [];
  const n = text.length;
  let start = 0;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (!TERMINAL.includes(ch)) continue;
    let end = i;
    while (end + 1 < n && (TERMINAL.includes(text[end + 1]) || CLOSERS.includes(text[end + 1]))) end++;
    let next = end + 1;
    while (next < n && /\s/.test(text[next])) next++;
    if (next >= n) break;

    let ws = i - 1;
    while (ws >= 0 && /\S/.test(text[ws])) ws--;
    const word = text.slice(ws + 1, i).replace(/^[("'“‘[]+/, "");
    const soFar = text.slice(start, i).trim();

    if (next === end + 1) {
      // No space after the stop: a decimal, an abbreviation, or a missing
      // space between sentences, which is only assumed for plain words.
      const glued = ch === "." && /^[a-z]{4,}$/.test(word) && /[A-Z]/.test(text[next]);
      if (!glued) {
        i = end;
        continue;
      }
    } else if (/[a-z]/.test(text[next])) {
      i = end;
      continue;
    }
    if (ch === ".") {
      const w = word.toLowerCase();
      if (/^\d+$/.test(soFar)) {
        i = end;
        continue;
      }
      if (ABBREVIATIONS.has(w) || ABBREVIATIONS.has(w.replace(/\.$/, ""))) {
        i = end;
        continue;
      }
      if (/^(?:[A-Za-z]\.)*[A-Za-z]$/.test(word)) {
        i = end;
        continue;
      }
      if (/^\d+(?:\.\d+)*$/.test(word) && soFar.length < 8) {
        i = end;
        continue;
      }
    }
    const s = text.slice(start, end + 1).trim();
    if (s) out.push(s);
    start = end + 1;
    i = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

// Kokoro's tokenizer truncates at about 510 tokens, so long sentences are cut
// at clause boundaries before synthesis.
export function chunkSentence(text) {
  if (text.length <= MAX_CHUNK) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > MAX_CHUNK) {
    const window = rest.slice(0, MAX_CHUNK);
    let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
    if (cut < MAX_CHUNK / 3) cut = window.lastIndexOf(" ");
    if (cut < 1) cut = MAX_CHUNK;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

// Turns the included blocks into the flat list of sentences the player walks.
export function sentencesFromBlocks(blocks) {
  const out = [];
  for (const block of blocks) {
    if (!block.included || !block.speech) continue;
    const parts = splitSentences(block.speech).flatMap(chunkSentence);
    parts.forEach((part, k) => {
      const text = part.replace(/\s+/g, " ").trim();
      if (text.replace(/[^\p{L}\p{N}]/gu, "").length === 0) return;
      const s = { id: out.length, block: block.id, ordinal: k, page: block.page, kind: block.kind, text };
      if (k === 0 && parts.length === 1) {
        // The stop added for the voice and the stripped section number are
        // not shown on the page.
        let display = text;
        if (display.endsWith(".") && !/[.!?…:]$/.test(block.text)) display = display.slice(0, -1);
        if (block.number && (block.kind === "heading" || block.kind === "reference")) display = `${block.number} ${display}`;
        if (display !== text) s.display = display;
      }
      out.push(s);
    });
  }
  return out;
}
