import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extractPages } from "./pdf.js";
import { encodeWav } from "./wav.js";
import "./styles.css";

const LOOKAHEAD = 3;
const CHARS_PER_SECOND = 14;

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
  const [engine, setEngine] = useState({ status: "loading", loaded: 0, total: 0, voices: [] });
  const [doc, setDoc] = useState(null);
  const [docProgress, setDocProgress] = useState(null);
  const [docError, setDocError] = useState(null);
  const [sentences, setSentences] = useState([]);
  const [range, setRange] = useState({ from: 1, to: 1 });
  const [voice, setVoice] = useState("af_heart");
  const [speed, setSpeed] = useState(1);
  const [status, setStatus] = useState("idle"); // idle | playing | paused | buffering
  const [index, setIndex] = useState(0);
  const [download, setDownload] = useState(null); // null | {done,total} | {url,name}
  const [dragging, setDragging] = useState(false);

  const workerRef = useRef(null);
  const ctxRef = useRef(null);
  const cacheRef = useRef(new Map());
  const pendingRef = useRef(new Set());
  const waitersRef = useRef(new Map());
  const sessionRef = useRef(0);
  const sourceRef = useRef(null);
  const statusRef = useRef("idle");
  const indexRef = useRef(0);
  const settingsRef = useRef({ voice, speed });
  const boundsRef = useRef({ first: 0, last: -1 });
  const fileInputRef = useRef(null);
  const currentElRef = useRef(null);

  settingsRef.current = { voice, speed };

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

  const request = useCallback((i, sentenceList) => {
    if (cacheRef.current.has(i) || pendingRef.current.has(i)) return;
    const s = sentenceList[i];
    if (!s) return;
    pendingRef.current.add(i);
    workerRef.current?.postMessage({
      type: "generate",
      id: i,
      session: sessionRef.current,
      text: s.text,
      voice: settingsRef.current.voice,
      speed: settingsRef.current.speed,
    });
  }, []);

  const sentencesRef = useRef(sentences);
  sentencesRef.current = sentences;

  const ensureQueued = useCallback(
    (from) => {
      const { last } = boundsRef.current;
      for (let i = from; i <= Math.min(from + LOOKAHEAD, last); i++) request(i, sentencesRef.current);
    },
    [request],
  );

  const startSource = useCallback(
    (i) => {
      const clip = cacheRef.current.get(i);
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
        case "split":
          setSentences(msg.sentences);
          break;
        case "audio": {
          if (msg.session !== sessionRef.current) break;
          cacheRef.current.set(msg.id, { samples: msg.samples, sampleRate: msg.sampleRate });
          pendingRef.current.delete(msg.id);
          waitersRef.current.get(msg.id)?.resolve?.();
          waitersRef.current.delete(msg.id);
          if (statusRef.current === "buffering" && indexRef.current === msg.id) {
            startSource(msg.id);
            ensureQueued(msg.id + 1);
          }
          break;
        }
        case "audio-error":
          pendingRef.current.delete(msg.id);
          waitersRef.current.get(msg.id)?.reject?.(new Error(msg.message));
          waitersRef.current.delete(msg.id);
          if (statusRef.current === "buffering" && indexRef.current === msg.id) {
            // Skip a sentence the model could not read.
            if (msg.id + 1 <= boundsRef.current.last) playIndexRef.current(msg.id + 1);
            else setPlayback("idle");
          }
          break;
      }
    };
    worker.postMessage({ type: "load" });
    return () => worker.terminate();
  }, [startSource, ensureQueued, setPlayback]);

  // Any change of voice or speed invalidates generated audio.
  useEffect(() => {
    const wasPlaying = statusRef.current === "playing" || statusRef.current === "buffering";
    resetAudio();
    setDownload((d) => (d?.url ? null : d));
    if (wasPlaying) playIndexRef.current(indexRef.current);
    else if (statusRef.current !== "idle") setPlayback("idle");
  }, [voice, speed, resetAudio, setPlayback]);

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

  const openFile = useCallback(
    async (file) => {
      if (!file || !/pdf$/i.test(file.name) && file.type !== "application/pdf") {
        setDocError("That file is not a PDF.");
        return;
      }
      setDocError(null);
      resetAudio();
      setPlayback("idle");
      setDownload(null);
      setSentences([]);
      setDoc(null);
      setDocProgress({ page: 0, total: 0 });
      try {
        const result = await extractPages(file, (page, total) => setDocProgress({ page, total }));
        setDoc(result);
        setRange({ from: 1, to: result.pages.length });
        setCurrent(0);
        workerRef.current?.postMessage({ type: "split", pages: result.pages });
      } catch (err) {
        setDocError(`Could not read this PDF. ${err?.message || ""}`.trim());
      } finally {
        setDocProgress(null);
      }
    },
    [resetAudio, setPlayback, setCurrent],
  );

  const togglePlay = useCallback(() => {
    if (engine.status !== "ready" || bounds.last < 0) return;
    const ctx = getCtx();
    if (statusRef.current === "playing") {
      ctx.suspend();
      setPlayback("paused");
    } else if (statusRef.current === "paused" && sourceRef.current) {
      ctx.resume();
      setPlayback("playing");
    } else {
      playIndex(indexRef.current);
    }
  }, [engine.status, bounds.last, getCtx, playIndex, setPlayback]);

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
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
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
    const ids = [];
    for (let i = bounds.first; i <= bounds.last; i++) ids.push(i);
    const session = sessionRef.current;
    setDownload({ done: 0, total: ids.length });
    const chunks = [];
    let rate = 24000;
    try {
      for (let n = 0; n < ids.length; n++) {
        const i = ids[n];
        if (!cacheRef.current.has(i)) {
          await new Promise((resolve, reject) => {
            waitersRef.current.set(i, { resolve, reject });
            request(i, sentencesRef.current);
          });
        }
        if (sessionRef.current !== session) throw new Error("cancelled");
        const clip = cacheRef.current.get(i);
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

  const voiceGroups = useMemo(() => {
    const byGrade = (a, b) => a.grade.localeCompare(b.grade) || a.name.localeCompare(b.name);
    return [
      { label: "American English", items: engine.voices.filter((v) => v.language === "en-us").sort(byGrade) },
      { label: "British English", items: engine.voices.filter((v) => v.language === "en-gb").sort(byGrade) },
    ];
  }, [engine.voices]);

  const pageBlocks = useMemo(() => {
    const blocks = [];
    let block = null;
    let para = null;
    sentences.forEach((s, i) => {
      if (!block || block.page !== s.page) {
        block = { page: s.page, paras: [] };
        blocks.push(block);
        para = null;
      }
      if (!para || para.key !== s.para) {
        para = { key: s.para, items: [] };
        block.paras.push(para);
      }
      para.items.push({ ...s, i });
    });
    return blocks;
  }, [sentences]);

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
        <p className="brand-sub">Turns a PDF into speech, entirely in your browser. Nothing is uploaded.</p>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => openFile(e.target.files?.[0])}
        />
        <button className="btn-primary" onClick={() => fileInputRef.current?.click()} disabled={!!docProgress}>
          {doc ? "Choose another PDF" : "Choose a PDF"}
        </button>

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
              max={doc?.pages.length || 1}
              value={range.from}
              disabled={!doc}
              onChange={(e) => {
                const v = Math.min(Math.max(1, +e.target.value || 1), range.to);
                setRange((r) => ({ ...r, from: v }));
              }}
            />
            <span className="pages-to">to</span>
            <input
              type="number"
              min="1"
              max={doc?.pages.length || 1}
              value={range.to}
              disabled={!doc}
              onChange={(e) => {
                const max = doc?.pages.length || 1;
                const v = Math.max(Math.min(max, +e.target.value || max), range.from);
                setRange((r) => ({ ...r, to: v }));
              }}
            />
            {doc && <span className="pages-total">of {doc.pages.length}</span>}
          </div>
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
        {!doc && !docProgress && (
          <div className="empty">
            <h2>Drop in a PDF.<br />Press play.</h2>
            <p>
              The voice model downloads once, about 90 MB, then stays cached. Works best in Chrome or Edge on a
              computer with a graphics card.
            </p>
            <button className="btn-primary" onClick={() => fileInputRef.current?.click()}>
              Choose a PDF
            </button>
            {docError && <p className="error">{docError}</p>}
          </div>
        )}

        {docProgress && (
          <div className="empty">
            <h2>Reading the file</h2>
            <p>{docProgress.total ? `Page ${docProgress.page} of ${docProgress.total}` : "Opening"}</p>
          </div>
        )}

        {doc && !docProgress && (
          <article className="document">
            <header className="doc-head">
              <h2>{doc.title}</h2>
              <p>
                {doc.pages.length} {doc.pages.length === 1 ? "page" : "pages"}
                {sentences.length > 0 && `, ${sentences.length} sentences`}
              </p>
              {docError && <p className="error">{docError}</p>}
            </header>
            {sentences.length === 0 && <p className="muted">Splitting into sentences</p>}
            {sentences.length === 0 && doc.pages.every((p) => !p.trim()) && (
              <p className="error">
                No text was found. This PDF is probably scanned images, which need OCR before they can be read aloud.
              </p>
            )}
            {pageBlocks.map((block) => {
              const active = block.page >= range.from && block.page <= range.to;
              return (
                <section key={block.page} className={`page ${active ? "" : "page-out"}`}>
                  <div className="page-num" aria-label={`Page ${block.page}`}>
                    {block.page}
                  </div>
                  {block.paras.map((para) => (
                    <p key={para.key}>
                      {para.items.map((s) => {
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
                            {s.text}{" "}
                          </span>
                        );
                      })}
                    </p>
                  ))}
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
                  Page {current.page}, sentence {position} of {inRange}
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
              <span className="muted">{engine.status === "ready" ? "Choose a PDF to begin" : "Getting the voice ready"}</span>
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
