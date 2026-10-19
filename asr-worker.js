/* =========================================================
   كابشن AI — تفريغ الكلام على الجهاز نفسه (دون خادم)
   يعمل في Web Worker حتى لا تتجمّد الواجهة، ويستخدم نماذج Whisper عبر مكتبة transformers.js.
   - WebGPU (معالج الرسوميات) عند توفره، مثل Chrome على Galaxy S24، وإلا WebAssembly (المعالج).
   - يُنزَّل النموذج مرة واحدة ثم يُحفظ في ذاكرة المتصفح ويعمل دون إنترنت.
   ========================================================= */
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

env.allowLocalModels = false;   // النماذج من Hugging Face فقط
env.useBrowserCache = typeof caches !== "undefined"; // حفظ النموذج بعد أول تنزيل (يتطلب اتصالاً آمناً)

const MODELS = {
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small",
  turbo: "onnx-community/whisper-large-v3-turbo",
};
const SR = 16000;               // Whisper يعمل على صوت 16kHz
const CHUNK_S = 30;             // أقصى طول يعالجه Whisper دفعة واحدة

let asr = null;
let loadedKey = "";
let gpuInfo = null;

/** هل يتوفر WebGPU؟ وهل يدعم الأعداد العشرية النصفية (fp16) لتسريع أكبر؟ */
async function detectGpu() {
  if (gpuInfo) return gpuInfo;
  gpuInfo = { webgpu: false, f16: false };
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) gpuInfo = { webgpu: true, f16: adapter.features.has("shader-f16") };
    }
  } catch (_) { /* لا WebGPU */ }
  return gpuInfo;
}

function dtypeFor(model, device) {
  // على WebGPU: مُرمِّز q4 مضغوط. تجنّبنا fp16 لأنه أعطى نصاً خاطئاً تماماً على بعض معالجات الرسوميات
  // (اختُبر: كلمة واحدة بدل 4 جمل)، بينما q4 أعطى النص نفسه تقريباً مثل fp32 وبحجم أصغر بكثير.
  if (device === "webgpu") return { encoder_model: "q4", decoder_model_merged: "q4" };
  return { encoder_model: "q8", decoder_model_merged: "q8" };
}

/** تحميل النموذج مع إرسال نسبة التنزيل الإجمالية لكل الملفات */
async function load(model) {
  const { webgpu } = await detectGpu();
  if (model === "turbo" && !webgpu) model = "small"; // النموذج الكبير يحتاج معالج رسوميات
  const devices = webgpu ? ["webgpu", "wasm"] : ["wasm"];
  for (const device of devices) {
    const key = model + ":" + device;
    if (asr && loadedKey === key) return { model, device };
    const files = {};
    try {
      if (asr) { await asr.dispose?.(); asr = null; }
      asr = await pipeline("automatic-speech-recognition", MODELS[model], {
        device,
        dtype: dtypeFor(model, device),
        progress_callback: (p) => {
          if (p.status === "progress" && p.total) {
            files[p.file] = { loaded: p.loaded, total: p.total };
            const all = Object.values(files);
            const loaded = all.reduce((s, f) => s + f.loaded, 0);
            const total = all.reduce((s, f) => s + f.total, 0);
            self.postMessage({ type: "download", loaded, total, percent: Math.round((loaded / total) * 100) });
          }
        },
      });
      loadedKey = key;
      return { model, device };
    } catch (err) {
      asr = null;
      // انقطاع التنزيل ليس عطلاً في WebGPU: نوقف ونطلب إعادة المحاولة (الملفات المكتملة محفوظة)
      if (device === "wasm" || /network error|Failed to fetch|NetworkError|ERR_/i.test(String(err && err.message || err))) {
        throw new Error("NETWORK: " + (err && err.message || err));
      }
      console.warn("WebGPU failed, falling back to WASM:", err);
    }
  }
}

function rms(audio, from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += audio[i] * audio[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

/** نقطة القطع: أهدأ لحظة في آخر 5 ثوانٍ من المقطع، حتى لا تُقطع الكلمات في منتصفها */
function findCut(audio, start) {
  const hardEnd = Math.min(audio.length, start + CHUNK_S * SR);
  if (hardEnd === audio.length) return hardEnd;
  const frame = Math.round(0.1 * SR);
  let best = hardEnd, bestE = Infinity;
  for (let pos = hardEnd - 5 * SR; pos + frame <= hardEnd; pos += frame) {
    const e = rms(audio, pos, pos + frame);
    if (e < bestE) { bestE = e; best = pos + Math.round(frame / 2); }
  }
  return best;
}

function buildText(segments) {
  const paras = [];
  let cur = [], len = 0, prevEnd = null;
  for (const s of segments) {
    const t = s.text.trim();
    if (!t) continue;
    const gap = prevEnd === null ? 0 : s.start - prevEnd;
    const endsSentence = cur.length && /[.!?؟…]$/.test(cur[cur.length - 1]);
    if (cur.length && ((gap >= 2 && len >= 150) || (len >= 550 && endsSentence))) {
      paras.push(cur.join(" ")); cur = []; len = 0;
    }
    cur.push(t); len += t.length; prevEnd = s.end;
  }
  if (cur.length) paras.push(cur.join(" "));
  return paras.join("\n\n");
}

async function transcribe(audio, language) {
  const segments = [];
  const duration = audio.length / SR;
  let start = 0;
  while (start < audio.length) {
    const end = findCut(audio, start);
    const chunk = audio.subarray(start, end);
    const offset = start / SR;
    // تخطّي المقاطع الصامتة: Whisper «يتخيّل» نصوصاً على الصمت
    if (rms(chunk, 0, chunk.length) > 0.003) {
      const opts = { task: "transcribe", return_timestamps: true };
      if (language) opts.language = language;
      const out = await asr(chunk, opts);
      const chunkLen = chunk.length / SR;
      const parts = out.chunks && out.chunks.length ? out.chunks : [{ timestamp: [0, chunkLen], text: out.text || "" }];
      for (const p of parts) {
        const text = (p.text || "").trim();
        if (!text) continue;
        const s = offset + (p.timestamp?.[0] ?? 0);
        const e = offset + Math.min(p.timestamp?.[1] ?? chunkLen, chunkLen);
        segments.push({ start: s, end: Math.max(e, s + 0.3), text });
      }
    }
    start = end;
    self.postMessage({
      type: "progress",
      percent: Math.min(99, Math.round((start / audio.length) * 100)),
      processed: start / SR,
      duration,
      partial: buildText(segments),
    });
  }
  return segments;
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "probe") {
      self.postMessage({ type: "probe", ...(await detectGpu()) });
    } else if (msg.type === "transcribe") {
      self.postMessage({ type: "stage", stage: "loading" });
      const used = await load(msg.model);
      self.postMessage({ type: "stage", stage: "transcribing", ...used });
      const segments = await transcribe(msg.audio, msg.language);
      self.postMessage({ type: "done", segments, text: buildText(segments), ...used });
    }
  } catch (err) {
    self.postMessage({ type: "error", message: String(err && err.message || err) });
  }
};
