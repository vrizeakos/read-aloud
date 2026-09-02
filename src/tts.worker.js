import { KokoroTTS, TextSplitterStream } from "kokoro-js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
// Kokoro's tokenizer truncates at ~510 tokens, so very long sentences are
// split into smaller chunks before synthesis.
const MAX_CHUNK_CHARS = 380;

let tts = null;
let device = null;
let queue = [];
let running = false;
let session = 0;

function post(msg, transfer) {
  self.postMessage(msg, transfer);
}

async function pickDevice() {
  if (self.navigator?.gpu) {
    try {
      const adapter = await self.navigator.gpu.requestAdapter();
      if (adapter) return "webgpu";
    } catch {
      /* fall through to wasm */
    }
  }
  return "wasm";
}

async function load() {
  if (tts) return;
  device = await pickDevice();
  const dtype = device === "webgpu" ? "fp32" : "q8";
  const seen = new Map();
  tts = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype,
    device,
    progress_callback: (p) => {
      if (p.status === "progress") {
        seen.set(p.file, { loaded: p.loaded, total: p.total });
        let loaded = 0;
        let total = 0;
        for (const v of seen.values()) {
          loaded += v.loaded;
          total += v.total;
        }
        post({ type: "load-progress", loaded, total, file: p.file });
      }
    },
  });
  const voices = Object.entries(tts.voices).map(([id, v]) => ({
    id,
    name: v.name,
    language: v.language,
    gender: v.gender,
    grade: v.overallGrade,
  }));
  post({ type: "ready", device, dtype, voices });
}

function splitLongSentence(text) {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > MAX_CHUNK_CHARS) {
    const window = rest.slice(0, MAX_CHUNK_CHARS);
    let cut = Math.max(
      window.lastIndexOf(", "),
      window.lastIndexOf("; "),
      window.lastIndexOf(": "),
    );
    if (cut < MAX_CHUNK_CHARS / 3) cut = window.lastIndexOf(" ");
    if (cut < 1) cut = MAX_CHUNK_CHARS;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function splitPages(pages) {
  const out = [];
  pages.forEach((text, i) => {
    const paragraphs = text.split(/\n\s*\n/);
    paragraphs.forEach((para, p) => {
      const splitter = new TextSplitterStream();
      splitter.push(para);
      splitter.close();
      for (const sentence of splitter.sentences) {
        for (const chunk of splitLongSentence(sentence)) {
          const clean = chunk.replace(/\s+/g, " ").trim();
          if (clean.replace(/[^\p{L}\p{N}]/gu, "").length === 0) continue;
          out.push({ id: out.length, page: i + 1, para: p, text: clean });
        }
      }
    });
  });
  return out;
}

async function drain() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    if (job.session !== session) continue;
    try {
      const audio = await tts.generate(job.text, {
        voice: job.voice,
        speed: job.speed,
      });
      if (job.session !== session) continue;
      const data = audio.audio;
      post(
        {
          type: "audio",
          id: job.id,
          session: job.session,
          samples: data,
          sampleRate: audio.sampling_rate,
        },
        [data.buffer],
      );
    } catch (err) {
      post({ type: "audio-error", id: job.id, session: job.session, message: String(err?.message || err) });
    }
  }
  running = false;
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case "load":
        await load();
        break;
      case "split":
        post({ type: "split", requestId: msg.requestId, sentences: splitPages(msg.pages) });
        break;
      case "generate":
        // Ignore duplicates already waiting in the queue.
        if (!queue.some((q) => q.id === msg.id && q.session === msg.session)) {
          queue.push(msg);
        }
        drain();
        break;
      case "reset":
        // Drops every pending job; results for the old session are discarded.
        session = msg.session;
        queue = [];
        break;
    }
  } catch (err) {
    post({ type: "error", message: String(err?.message || err) });
  }
};
