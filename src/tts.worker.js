import { KokoroTTS } from "kokoro-js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

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

async function drain() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    if (job.session !== session) continue;
    try {
      const audio = await tts.generate(job.text, { voice: job.voice, speed: job.speed });
      if (job.session !== session) continue;
      const data = audio.audio;
      post(
        { type: "audio", key: job.key, session: job.session, samples: data, sampleRate: audio.sampling_rate },
        [data.buffer],
      );
    } catch (err) {
      post({ type: "audio-error", key: job.key, session: job.session, message: String(err?.message || err) });
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
      case "generate":
        // Ignore duplicates already waiting in the queue.
        if (!queue.some((q) => q.key === msg.key && q.session === msg.session)) queue.push(msg);
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
