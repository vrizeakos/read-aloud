import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readPdf } from "./pdf.js";
import { analyzeLayout, applyOptions, DEFAULT_OPTIONS, KIND_LABEL } from "./paper.js";
import { blocksFromText } from "./textinput.js";
import { sentencesFromBlocks } from "./sentences.js";
import { encodeWav } from "./wav.js";
import "./styles.css";

const LOOKAHEAD = 3;
const CHARS_PER_SECOND = 14;
const CACHE_HIGH = 90;
const CACHE_LOW = 60;
const STORAGE_KEY = "read-aloud.settings";
const TAGGED = new Set(["caption", "table", "code", "footnote", "equation", "reference"]);
const OPTION_LABELS = [
  ["skipReferences", "Skip references"],
  ["skipTables", "Skip tables and code"],
  ["skipCaptions", "Skip figure captions"],
  ["skipFootnotes", "Skip footnotes"],
  ["skipEquations", "Skip equations"],
  ["stripCitations", "Strip citations"],
];

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* fresh start */
  }
  return {};
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* private mode or full storage */
  }
}

function looksLikeMarkdown(text) {
  return /^#{1,6}\s|^\s*[-*+]\s|\|.*\|.*\n|\*\*[^*]+\*\*|```/m.test(text);
}

function formatBytes(n) {
  return `${Math.round(n / 1048576)} MB`;
}

function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "";
  const m = Math.round(seconds / 60);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

function groupLabel(blocks) {
  const kind = blocks[0].kind;
  const same = blocks.every((b) => b.kind === kind);
  const label = same ? KIND_LABEL[kind] || kind : `${KIND_LABEL[kind] || kind} and more`;
  if (blocks.length === 1) return label;
  if (kind === "reference" && same) return `References (${blocks.length})`;
  return `${label} (${blocks.length})`;
}

const Icon = {
  play: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  ),
  pause: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
    </svg>
  ),
  prev: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M17 6v12l-8.5-6zM6 6h2v12H6z" />
    </svg>
  ),
  next: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 6v12l8.5-6zM16 6h2v12h-2z" />
    </svg>
  ),
  download: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M11 4h2v9.2l3.6-3.6 1.4 1.4-6 6-6-6 1.4-1.4L11 13.2zM5 18h14v2H5z" />
    </svg>
  ),
};

export default function App() {
  const settings = useMemo(loadSettings, []);
  const [engine, setEngine] = useState({ status: "loading", loaded: 0, total: 0, voices: [] });
  const [doc, setDoc] = useState(null);
  const [docProgress, setDocProgress] = useState(null);
  const [docError, setDocError] = useState(null);
  const [options, setOptions] = useState({ ...DEFAULT_OPTIONS, ...(settings.options || {}) });
  const [overrides, setOverrides] = useState(() => new Map());
  const [range, setRange] = useState({ from: 1, to: 1 });
  const [voice, setVoice] = useState(settings.voice || "af_heart");
  const [speed, setSpeed] = useState(settings.speed || 1);
  const [status, setStatus] = useState("idle"); // idle | playing | paused | buffering
  const [index, setIndex] = useState(0);
  const [download, setDownload] = useState(null); // null | {done,total} | {url,name}
  const [dragging, setDragging] = useState(false);
  const [paste, setPaste] = useState(null); // null | { text }

  const workerRef = useRef(null);
  const ctxRef = useRef(null);
  const cacheRef = useRef(new Map()); // sentence text -> audio clip
  const pendingRef = useRef(new Set());
  const waitersRef = useRef(new Map());
  const sessionRef = useRef(0);
  const sourceRef = useRef(null);
  const statusRef = useRef("idle");
  const indexRef = useRef(0);
  const cursorRef = useRef(null); // { block, ordinal } of the current sentence
  const settingsRef = useRef({ voice, speed });
  const boundsRef = useRef({ first: 0, last: -1 });
  const fileInputRef = useRef(null);
  const currentElRef = useRef(null);
  const downloadingRef = useRef(false);

  settingsRef.current = { voice, speed };

  useEffect(() => {
    saveSettings({ options, voice, speed });
  }, [options, voice, speed]);

  // Which blocks are read, and the sentences the player walks through.
  const applied = useMemo(() => (doc ? applyOptions(doc.blocks, options, overrides) : []), [doc, options, overrides]);
  const sentences = useMemo(() => sentencesFromBlocks(applied), [applied]);
  const sentencesRef = useRef(sentences);
  sentencesRef.current = sentences;

  const bounds = useMemo(() => {
    let first = -1;
    let last = -1;
    sentences.forEach((s, i) => {
      if (s.page >= range.from && s.page <= range.to) {
        if (first < 0) first = i;
        last = i;
      }
    });
    return { first: Math.max(first, 0), last };
  }, [sentences, range]);
  boundsRef.current = bounds;

  const setPlayback = useCallback((s) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  const setCurrent = useCallback((i) => {
    indexRef.current = i;
    setIndex(i);
    const s = sentencesRef.current[i];
    cursorRef.current = s ? { block: s.block, ordinal: s.ordinal } : null;
  }, []);

  const getCtx = useCallback(() => {
    if (!ctxRef.current) ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    return ctxRef.current;
  }, []);

  const stopSource = useCallback(() => {
    if (sourceRef.current) {
      const { source } = sourceRef.current;
      sourceRef.current = null;
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
  }, []);

  const request = useCallback((i) => {
    const s = sentencesRef.current[i];
    if (!s) return;
    const key = s.text;
    if (cacheRef.current.has(key) || pendingRef.current.has(key)) return;
    pendingRef.current.add(key);
    workerRef.current?.postMessage({
      type: "generate",
      key,
      session: sessionRef.current,
      text: key,
      voice: settingsRef.current.voice,
      speed: settingsRef.current.speed,
    });
  }, []);

  const ensureQueued = useCallback(
    (from) => {
      const { last } = boundsRef.current;
      for (let i = from; i <= Math.min(from + LOOKAHEAD, last); i++) request(i);
    },
    [request],
  );

  // Audio already played is released; what lies ahead of the cursor stays.
  const evict = useCallback((keep) => {
    const cache = cacheRef.current;
    if (cache.size <= CACHE_HIGH || downloadingRef.current) return;
    const protect = new Set([keep]);
    const list = sentencesRef.current;
    for (let i = indexRef.current; i <= Math.min(indexRef.current + LOOKAHEAD + 2, list.length - 1); i++) {
      protect.add(list[i].text);
    }
    for (const key of cache.keys()) {
      if (cache.size <= CACHE_LOW) break;
      if (!protect.has(key)) cache.delete(key);
    }
  }, []);

  const startSource = useCallback(
    (i) => {
      const s = sentencesRef.current[i];
      const clip = s && cacheRef.current.get(s.text);
      if (!clip) return false;
      const ctx = getCtx();
      if (ctx.state === "suspended") ctx.resume();
      stopSource();
      const buffer = ctx.createBuffer(1, clip.samples.length, clip.sampleRate);
      buffer.copyToChannel(clip.samples, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const handle = { source };
      sourceRef.current = handle;
      source.onended = () => {
        if (sourceRef.current !== handle) return; // stopped by the user
        sourceRef.current = null;
        const next = i + 1;
        if (next <= boundsRef.current.last && statusRef.current === "playing") {
          playIndexRef.current(next);
        } else {
          setPlayback("idle");
        }
      };
      source.start();
      setPlayback("playing");
      return true;
    },
    [getCtx, stopSource, setPlayback],
  );

  const playIndexRef = useRef(() => {});
  const playIndex = useCallback(
    (i) => {
      const { first, last } = boundsRef.current;
      if (last < 0) return;
      const clamped = Math.min(Math.max(i, first), last);
      setCurrent(clamped);
      ensureQueued(clamped);
      if (!startSource(clamped)) {
        stopSource();
        setPlayback("buffering");
      }
    },
    [ensureQueued, startSource, stopSource, setCurrent, setPlayback],
  );
  playIndexRef.current = playIndex;

  const resetAudio = useCallback(() => {
    stopSource();
    sessionRef.current += 1;
    cacheRef.current.clear();
    pendingRef.current.clear();
    for (const [, w] of waitersRef.current) w.reject(new Error("cancelled"));
    waitersRef.current.clear();
    workerRef.current?.postMessage({ type: "reset", session: sessionRef.current });
  }, [stopSource]);

  // Worker setup
  useEffect(() => {
    const worker = new Worker(new URL("./tts.worker.js", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (e) => {
      const msg = e.data;
      switch (msg.type) {
        case "load-progress":
          setEngine((prev) => ({ ...prev, status: "loading", loaded: msg.loaded, total: msg.total }));
          break;
        case "ready":
          setEngine({ status: "ready", device: msg.device, voices: msg.voices, loaded: 0, total: 0 });
          break;
        case "error":
          setEngine((prev) => ({ ...prev, status: "error", message: msg.message }));
          break;
        case "audio": {
          if (msg.session !== sessionRef.current) break;
          cacheRef.current.set(msg.key, { samples: msg.samples, sampleRate: msg.sampleRate });
          pendingRef.current.delete(msg.key);
          waitersRef.current.get(msg.key)?.resolve?.();
          waitersRef.current.delete(msg.key);
          const current = sentencesRef.current[indexRef.current];
          if (statusRef.current === "buffering" && current?.text === msg.key) {
            startSource(indexRef.current);
            ensureQueued(indexRef.current + 1);
          }
          evict(msg.key);
          break;
        }
        case "audio-error": {
          pendingRef.current.delete(msg.key);
          waitersRef.current.get(msg.key)?.reject?.(new Error(msg.message));
          waitersRef.current.delete(msg.key);
          const current = sentencesRef.current[indexRef.current];
          if (statusRef.current === "buffering" && current?.text === msg.key) {
            // Skip a sentence the model could not read.
            if (indexRef.current + 1 <= boundsRef.current.last) playIndexRef.current(indexRef.current + 1);
            else setPlayback("idle");
          }
          break;
        }
      }
    };
    worker.postMessage({ type: "load" });
    return () => worker.terminate();
  }, [startSource, ensureQueued, setPlayback, evict]);

  // Any change of voice or speed invalidates generated audio.
  useEffect(() => {
    const wasPlaying = statusRef.current === "playing" || statusRef.current === "buffering";
    resetAudio();
    setDownload((d) => (d?.url ? null : d));
    if (wasPlaying) playIndexRef.current(indexRef.current);
    else if (statusRef.current !== "idle") setPlayback("idle");
  }, [voice, speed, resetAudio, setPlayback]);

  // When the set of sentences changes (a block toggled, an option changed),
  // the cursor follows the sentence it was on.
  const prevSentencesRef = useRef(sentences);
  useEffect(() => {
    if (prevSentencesRef.current === sentences) return;
    prevSentencesRef.current = sentences;
    const cur = cursorRef.current;
    let target = 0;
    if (cur && sentences.length) {
      let idx = sentences.findIndex((s) => s.block === cur.block && s.ordinal === cur.ordinal);
      if (idx < 0) idx = sentences.findIndex((s) => s.block === cur.block);
      if (idx < 0) idx = sentences.findIndex((s) => s.block > cur.block);
      if (idx < 0) idx = sentences.length - 1;
      target = idx;
    }
    const active = statusRef.current === "playing" || statusRef.current === "buffering";
    stopSource();
    if (active && sentences.length) {
      playIndexRef.current(target);
    } else {
      setPlayback("idle");
      setCurrent(target);
    }
  }, [sentences, stopSource, setPlayback, setCurrent]);

  // Keep the cursor inside the chosen page range.
  useEffect(() => {
    if (bounds.last < 0) return;
    if (indexRef.current < bounds.first || indexRef.current > bounds.last) {
      stopSource();
      setPlayback("idle");
      setCurrent(bounds.first);
    }
  }, [bounds, stopSource, setPlayback, setCurrent]);

  // Scroll the current sentence into view.
  useEffect(() => {
    const el = currentElRef.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }, [index]);

  const beginDocument = useCallback(() => {
    setDocError(null);
    resetAudio();
    setPlayback("idle");
    setDownload(null);
    setDoc(null);
    setOverrides(new Map());
    setPaste(null);
    cursorRef.current = null;
    indexRef.current = 0;
    setIndex(0);
  }, [resetAudio, setPlayback]);

  const finishDocument = useCallback((next) => {
    setDoc(next);
    setRange({ from: 1, to: next.pageCount });
  }, []);

  const openText = useCallback(
    (text, title, markdown) => {
      beginDocument();
      const blocks = blocksFromText(text, { markdown });
      finishDocument({ title, pageCount: 1, blocks, source: "text" });
    },
    [beginDocument, finishDocument],
  );

  const openFile = useCallback(
    async (file) => {
      if (!file) return;
      const name = file.name || "";
      const isPdf = /\.pdf$/i.test(name) || file.type === "application/pdf";
      const isText = /\.(txt|md|markdown|text)$/i.test(name) || /^text\//.test(file.type);
      if (!isPdf && !isText) {
        setDocError("That file is not a PDF, Markdown or plain text file.");
        return;
      }
      if (isText) {
        const text = await file.text();
        openText(text, name.replace(/\.[^.]+$/, ""), /\.(md|markdown)$/i.test(name) || looksLikeMarkdown(text));
        return;
      }
      beginDocument();
      setDocProgress({ page: 0, total: 0 });
      try {
        const { title, pages } = await readPdf(file, (page, total) => setDocProgress({ page, total }));
        const scanned = !pages.some((p) => p.items.length > 0);
        const blocks = scanned ? [] : analyzeLayout(pages).blocks;
        finishDocument({ title, pageCount: pages.length, blocks, source: "pdf", scanned });
      } catch (err) {
        setDocError(`Could not read this PDF. ${err?.message || ""}`.trim());
      } finally {
        setDocProgress(null);
      }
    },
    [beginDocument, finishDocument, openText],
  );

  const setOption = useCallback((key, value) => {
    setOptions((o) => ({ ...o, [key]: value }));
  }, []);

  const setOverride = useCallback((ids, included) => {
    setOverrides((prev) => {
      const next = new Map(prev);
      for (const id of ids) next.set(id, included);
      return next;
    });
  }, []);

  const togglePlay = useCallback(() => {
    if (engine.status !== "ready" || bounds.last < 0) return;
    const ctx = getCtx();
    if (statusRef.current === "playing") {
      ctx.suspend();
      setPlayback("paused");
    } else if (statusRef.current === "paused" && sourceRef.current) {
      ctx.resume();
      setPlayback("playing");
    } else if (statusRef.current === "buffering") {
      // Stop waiting for the voice; the sentence stays generated for later.
      stopSource();
      setPlayback("idle");
    } else {
      playIndex(indexRef.current);
    }
  }, [engine.status, bounds.last, getCtx, playIndex, stopSource, setPlayback]);

  const skip = useCallback(
    (delta) => {
      if (bounds.last < 0) return;
      const target = indexRef.current + delta;
      if (statusRef.current === "idle" || statusRef.current === "paused") {
        stopSource();
        setPlayback("idle");
        setCurrent(Math.min(Math.max(target, bounds.first), bounds.last));
      } else {
        playIndex(target);
      }
    },
    [bounds, playIndex, stopSource, setPlayback, setCurrent],
  );

  const jumpTo = useCallback(
    (i) => {
      if (i < bounds.first || i > bounds.last) return;
      if (statusRef.current === "playing" || statusRef.current === "buffering") playIndex(i);
      else {
        stopSource();
        setPlayback("idle");
        setCurrent(i);
      }
    },
    [bounds, playIndex, stopSource, setPlayback, setCurrent],
  );

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowRight") skip(1);
      else if (e.key === "ArrowLeft") skip(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, skip]);

  const downloadAudio = useCallback(async () => {
    if (engine.status !== "ready" || bounds.last < 0) return;
    const list = sentencesRef.current;
    const ids = [];
    for (let i = bounds.first; i <= bounds.last; i++) ids.push(i);
    const session = sessionRef.current;
    setDownload({ done: 0, total: ids.length });
    downloadingRef.current = true;
    const chunks = [];
    let rate = 24000;
    try {
      for (let n = 0; n < ids.length; n++) {
        const i = ids[n];
        const key = list[i].text;
        if (!cacheRef.current.has(key)) {
          await new Promise((resolve, reject) => {
            waitersRef.current.set(key, { resolve, reject });
            request(i);
          });
        }
        if (sessionRef.current !== session || sentencesRef.current !== list) throw new Error("cancelled");
        const clip = cacheRef.current.get(key);
        if (clip) {
          chunks.push(clip.samples);
          rate = clip.sampleRate;
        }
        setDownload({ done: n + 1, total: ids.length });
      }
      const blob = encodeWav(chunks, rate);
      const name = `${(doc?.title || "audio").replace(/[^\w\- ]+/g, "").trim() || "audio"}.wav`;
      setDownload({ url: URL.createObjectURL(blob), name });
    } catch (err) {
      if (err?.message !== "cancelled") setDocError(`Download stopped. ${err.message}`);
      setDownload(null);
    } finally {
      downloadingRef.current = false;
    }
  }, [engine.status, bounds, request, doc]);

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    openFile(e.dataTransfer.files?.[0]);
  };

  // Derived display values
  const inRange = bounds.last >= 0 ? bounds.last - bounds.first + 1 : 0;
  const position = bounds.last >= 0 ? index - bounds.first + 1 : 0;
  const remainingChars = useMemo(() => {
    let n = 0;
    for (let i = index; i <= bounds.last; i++) n += sentences[i]?.text.length || 0;
    return n;
  }, [index, bounds.last, sentences]);
  const remaining = formatDuration(remainingChars / CHARS_PER_SECOND / speed);
  const current = sentences[index];
  const readCount = useMemo(() => applied.filter((b) => b.included).length, [applied]);

  const voiceGroups = useMemo(() => {
    const byGrade = (a, b) => a.grade.localeCompare(b.grade) || a.name.localeCompare(b.name);
    return [
      { label: "American English", items: engine.voices.filter((v) => v.language === "en-us").sort(byGrade) },
      { label: "British English", items: engine.voices.filter((v) => v.language === "en-gb").sort(byGrade) },
    ];
  }, [engine.voices]);

  // Blocks laid out per page, with runs of skipped blocks folded into one row.
  const pages = useMemo(() => {
    const byBlock = new Map();
    sentences.forEach((s, i) => {
      if (!byBlock.has(s.block)) byBlock.set(s.block, []);
      byBlock.get(s.block).push({ ...s, i });
    });
    const out = new Map();
    for (const b of applied) {
      if (!out.has(b.page)) out.set(b.page, { number: b.page, items: [] });
      const page = out.get(b.page);
      if (b.included) {
        const items = byBlock.get(b.id) || [];
        if (items.length) page.items.push({ type: "block", block: b, sentences: items });
      } else {
        const last = page.items[page.items.length - 1];
        if (last && last.type === "skipped") last.blocks.push(b);
        else page.items.push({ type: "skipped", blocks: [b] });
      }
    }
    return [...out.values()];
  }, [applied, sentences]);

  const engineLine = (() => {
    if (engine.status === "loading") {
      return engine.total
        ? `Loading the voice model, ${formatBytes(engine.loaded)} of ${formatBytes(engine.total)}`
        : "Starting the voice model";
    }
    if (engine.status === "error") return `The voice model failed to load. ${engine.message || ""}`;
    return engine.device === "webgpu"
      ? "Voice runs on your graphics card, faster than real time"
      : "Voice runs on your processor, expect a short wait before each sentence";
  })();

  const renderSentence = (s, active) => {
    const isCurrent = s.i === index;
    return (
      <span
        key={s.i}
        ref={isCurrent ? currentElRef : null}
        className={`sentence ${isCurrent ? `sentence-current sentence-${status}` : ""}`}
        onClick={() => jumpTo(s.i)}
        role="button"
        tabIndex={active ? 0 : -1}
        onKeyDown={(e) => {
          if (e.key === "Enter") jumpTo(s.i);
        }}
      >
        {s.display ?? s.text}{" "}
      </span>
    );
  };

  const renderBlock = (item, active) => {
    const b = item.block;
    const tag = options.paperMode && TAGGED.has(b.kind) && (
      <span className="block-tag">
        {KIND_LABEL[b.kind]}
        <button
          className="block-skip"
          onClick={() => setOverride([b.id], false)}
          title="Set this block aside"
          aria-label={`Set aside this ${KIND_LABEL[b.kind].toLowerCase()}`}
        >
          ×
        </button>
      </span>
    );
    const body = item.sentences.map((s) => renderSentence(s, active));
    if (b.kind === "title") {
      return (
        <h2 key={b.id} className="block block-title">
          {body}
        </h2>
      );
    }
    if (b.kind === "heading" || (b.kind === "reference" && b.heading)) {
      return (
        <h3 key={b.id} className="block block-heading">
          {tag}
          {body}
        </h3>
      );
    }
    return (
      <p key={b.id} className={`block block-${b.kind}`}>
        {tag}
        {body}
      </p>
    );
  };

  const renderSkipped = (item, active, key) => {
    const ids = item.blocks.map((b) => b.id);
    const preview = item.blocks
      .map((b) => b.text)
      .join(" ")
      .slice(0, 140);
    return (
      <div
        key={key}
        className="skipped"
        role="button"
        tabIndex={active ? 0 : -1}
        title="Read this anyway"
        onClick={() => setOverride(ids, true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") setOverride(ids, true);
        }}
      >
        <span className="skipped-tag">{groupLabel(item.blocks)}</span>
        <span className="skipped-preview">{preview}</span>
        <span className="skipped-action">Read</span>
      </div>
    );
  };

  return (
    <div
      className={`app ${dragging ? "app-dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <aside className="rail">
        <h1 className="brand">Read Aloud</h1>
        <p className="brand-sub">Turns a paper into speech, entirely in your browser. Nothing is uploaded.</p>

        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown"
          hidden
          onChange={(e) => {
            openFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <div className="btn-row">
          <button className="btn-primary" onClick={() => fileInputRef.current?.click()} disabled={!!docProgress}>
            {doc ? "Open another file" : "Open a file"}
          </button>
          <button className="btn-secondary" onClick={() => setPaste({ text: "" })} disabled={!!docProgress}>
            Paste text
          </button>
        </div>

        <label className="field">
          <span>Voice</span>
          <select value={voice} onChange={(e) => setVoice(e.target.value)} disabled={engine.status !== "ready"}>
            {engine.voices.length === 0 && <option value="af_heart">Heart</option>}
            {voiceGroups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.items.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}, {v.gender.toLowerCase()}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <label className="field">
          <span>
            Speed <b>{speed.toFixed(2)}×</b>
          </span>
          <input
            type="range"
            min="0.7"
            max="1.6"
            step="0.05"
            value={speed}
            onChange={(e) => setSpeed(parseFloat(e.target.value))}
          />
        </label>

        <div className="field">
          <span>Pages</span>
          <div className="pages">
            <input
              type="number"
              min="1"
              max={doc?.pageCount || 1}
              value={range.from}
              disabled={!doc || doc.pageCount < 2}
              onChange={(e) => {
                const v = Math.min(Math.max(1, +e.target.value || 1), range.to);
                setRange((r) => ({ ...r, from: v }));
              }}
            />
            <span className="pages-to">to</span>
            <input
              type="number"
              min="1"
              max={doc?.pageCount || 1}
              value={range.to}
              disabled={!doc || doc.pageCount < 2}
              onChange={(e) => {
                const max = doc?.pageCount || 1;
                const v = Math.max(Math.min(max, +e.target.value || max), range.from);
                setRange((r) => ({ ...r, to: v }));
              }}
            />
            {doc && <span className="pages-total">of {doc.pageCount}</span>}
          </div>
        </div>

        <div className="field">
          <label className="switch">
            <input
              type="checkbox"
              checked={options.paperMode}
              onChange={(e) => setOption("paperMode", e.target.checked)}
            />
            <span>Paper mode</span>
          </label>
          <p className="field-help">
            Reads columns in order and sets aside headers, footers, page numbers and figure labels. Click any greyed
            block in the text to read it anyway.
          </p>
          {options.paperMode && (
            <div className="checks">
              {OPTION_LABELS.map(([key, label]) => (
                <label key={key}>
                  <input type="checkbox" checked={!!options[key]} onChange={(e) => setOption(key, e.target.checked)} />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className={`engine engine-${engine.status}`}>
          {engine.status === "loading" && engine.total > 0 && (
            <div className="engine-bar">
              <i style={{ width: `${Math.min(100, (engine.loaded / engine.total) * 100)}%` }} />
            </div>
          )}
          <p>{engineLine}</p>
          {engine.status === "error" && (
            <button
              className="btn-secondary btn-small"
              onClick={() => {
                setEngine((prev) => ({ ...prev, status: "loading", loaded: 0, total: 0 }));
                workerRef.current?.postMessage({ type: "load" });
              }}
            >
              Try again
            </button>
          )}
        </div>

        <p className="hint">Space plays and pauses. Arrow keys move between sentences. Click any sentence to start there.</p>
      </aside>

      <main className="stage">
        {paste && (
          <div className="empty paste">
            <h2>Paste the text.</h2>
            <p>
              Plain text or Markdown, for example the output of GROBID, Marker or Docling. Headings, tables, captions
              and references are recognised.
            </p>
            <textarea
              value={paste.text}
              onChange={(e) => setPaste({ text: e.target.value })}
              placeholder="Paste here"
              autoFocus
            />
            <div className="paste-actions">
              <button
                className="btn-primary"
                disabled={!paste.text.trim()}
                onClick={() => openText(paste.text, "Pasted text", looksLikeMarkdown(paste.text))}
              >
                Read this
              </button>
              <button className="btn-secondary" onClick={() => setPaste(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {!paste && !doc && !docProgress && (
          <div className="empty">
            <h2>
              Drop in a paper.
              <br />
              Press play.
            </h2>
            <p>
              PDF, Markdown or plain text. Research papers are cleaned up on the way in: running headers, tables,
              footnotes, citations and the reference list are set aside so the voice reads the prose. The voice model
              downloads once, about 90 MB, then stays cached.
            </p>
            <div className="btn-row">
              <button className="btn-primary" onClick={() => fileInputRef.current?.click()}>
                Open a file
              </button>
              <button className="btn-secondary" onClick={() => setPaste({ text: "" })}>
                Paste text
              </button>
            </div>
            {docError && <p className="error">{docError}</p>}
          </div>
        )}

        {docProgress && (
          <div className="empty">
            <h2>Reading the file</h2>
            <p>{docProgress.total ? `Page ${docProgress.page} of ${docProgress.total}` : "Opening"}</p>
          </div>
        )}

        {!paste && doc && !docProgress && (
          <article className="document">
            <header className="doc-head">
              <h2>{doc.title}</h2>
              <p className="doc-stats">
                <span>
                  {doc.pageCount} {doc.pageCount === 1 ? "page" : "pages"}
                </span>
                {doc.blocks.length > 0 && (
                  <span>
                    {readCount} of {doc.blocks.length} blocks read
                  </span>
                )}
                {sentences.length > 0 && <span>{sentences.length} sentences</span>}
                {overrides.size > 0 && (
                  <button className="link" onClick={() => setOverrides(new Map())}>
                    Reset choices
                  </button>
                )}
              </p>
              {docError && <p className="error">{docError}</p>}
            </header>
            {doc.scanned && (
              <p className="error">
                No text was found. This PDF is probably scanned images, which need OCR before they can be read aloud.
              </p>
            )}
            {!doc.scanned && doc.blocks.length > 0 && sentences.length === 0 && (
              <p className="muted">Everything in this document is set aside. Click a greyed block or change the paper mode settings.</p>
            )}
            {pages.map((page) => {
              const active = page.number >= range.from && page.number <= range.to;
              return (
                <section key={page.number} className={`page ${active ? "" : "page-out"}`}>
                  {doc.pageCount > 1 && (
                    <div className="page-num" aria-label={`Page ${page.number}`}>
                      {page.number}
                    </div>
                  )}
                  {page.items.map((item, k) =>
                    item.type === "block" ? renderBlock(item, active) : renderSkipped(item, active, `s${page.number}-${k}`),
                  )}
                </section>
              );
            })}
          </article>
        )}
      </main>

      <footer className="player">
        <div className="transport">
          <button className="btn-icon" onClick={() => skip(-1)} disabled={!current} aria-label="Previous sentence">
            {Icon.prev}
          </button>
          <button
            className={`btn-play ${status === "buffering" ? "btn-play-wait" : ""}`}
            onClick={togglePlay}
            disabled={!current || engine.status !== "ready"}
            aria-label={status === "playing" ? "Pause" : "Play"}
          >
            {status === "playing" ? Icon.pause : Icon.play}
          </button>
          <button className="btn-icon" onClick={() => skip(1)} disabled={!current} aria-label="Next sentence">
            {Icon.next}
          </button>
        </div>

        <div className="readout">
          {current ? (
            <>
              <div className="readout-line">
                <span>
                  {doc?.pageCount > 1 ? `Page ${current.page}, sentence` : "Sentence"} {position} of {inRange}
                </span>
                <span className="readout-state">
                  {status === "buffering" && "Generating"}
                  {status === "paused" && "Paused"}
                  {status === "playing" && remaining && `About ${remaining} left`}
                  {status === "idle" && remaining && `About ${remaining} to read`}
                </span>
              </div>
              <div className="progress">
                <i style={{ width: `${inRange ? (position / inRange) * 100 : 0}%` }} />
              </div>
            </>
          ) : (
            <div className="readout-line">
              <span className="muted">{engine.status === "ready" ? "Open a file to begin" : "Getting the voice ready"}</span>
            </div>
          )}
        </div>

        <div className="download">
          {download?.url ? (
            <a className="btn-secondary" href={download.url} download={download.name}>
              {Icon.download}
              <span>Save WAV</span>
            </a>
          ) : download ? (
            <button className="btn-secondary" disabled>
              <span>Generating </span>
              {download.done} of {download.total}
            </button>
          ) : (
            <button
              className="btn-secondary"
              onClick={downloadAudio}
              disabled={!current || engine.status !== "ready"}
              title="Generate the selected pages as one audio file"
            >
              {Icon.download}
              <span>Download audio</span>
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
