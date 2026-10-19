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

// =========================================================
// تنزيل قابل للاستئناف
// المكتبة تعيد تنزيل الملف من الصفر عند أي انقطاع، والمُرمِّز وحده قد يبلغ 425 ميغابايت.
// لذلك ننزّل كل ملف على أجزاء (4 ميغابايت) ونحفظ كل جزء فور وصوله، ونعيد محاولة الجزء الفاشل فقط.
// عند اكتمال الملف نجمعه ونضعه في ذاكرة المكتبة (transformers-cache) فتجده جاهزاً ولا تنزّله.
// =========================================================
const HF = "https://huggingface.co";
const PART = 4 * 1024 * 1024;
const LIB_CACHE = "transformers-cache";
const PART_CACHE = "captionai-partial";
const SUFFIX = { q4: "_q4", q8: "_quantized", fp16: "_fp16", fp32: "" };
const CONFIG_FILES = ["config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json"];

const isNetworkError = (err) => /network|Failed to fetch|NetworkError|ERR_|timed? ?out|HTTP 5\d\d|HTTP 429/i.test(String(err && err.message || err));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileUrl = (repo, path) => `${HF}/${repo}/resolve/main/${path}`;

/**
 * fetch مع كشف «التوقف» وإعادة محاولة متدرّجة (2، 4، 8… ثوانٍ).
 * لا نقطع الاتصال لأنه بطيء، بل فقط إذا لم يصل أي بايت لمدة STALL_MS، فيعمل حتى على اتصال ضعيف جداً.
 */
const STALL_MS = 30000;
async function fetchRetry(url, opts = {}, tries = 8, onBytes = null) {
  for (let i = 0; ; i++) {
    const ctrl = new AbortController();
    let timer = setTimeout(() => ctrl.abort(), STALL_MS);
    const alive = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), STALL_MS); };
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      if (res.status >= 500 || res.status === 429) throw new Error("HTTP " + res.status);
      if (!res.ok) throw Object.assign(new Error("HTTP " + res.status), { fatal: true });
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        alive();
        chunks.push(value);
        received += value.length;
        onBytes && onBytes(received);
      }
      return { res, blob: new Blob(chunks) };
    } catch (err) {
      if (err.fatal || i >= tries - 1) throw err.name === "AbortError" ? new Error("NetworkError: توقف الاتصال") : err;
      await sleep(Math.min(30000, 2000 * 2 ** i));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** أحجام ملفات النموذج من واجهة Hugging Face */
async function fileSizes(repo) {
  const { blob } = await fetchRetry(`${HF}/api/models/${repo}/tree/main/onnx`);
  const list = JSON.parse(await blob.text());
  return Object.fromEntries(list.map((f) => [f.path, f.lfs?.size || f.size || 0]));
}

async function ensureCached(repo, dtype) {
  if (typeof caches === "undefined") return; // اتصال غير آمن: نترك المكتبة تنزّل بطريقتها
  const lib = await caches.open(LIB_CACHE);
  const parts = await caches.open(PART_CACHE);

  // الملفات الصغيرة: تنزيل عادي مع إعادة المحاولة
  for (const name of CONFIG_FILES) {
    const url = fileUrl(repo, name);
    if (await lib.match(url)) continue;
    try {
      const { res, blob } = await fetchRetry(url);
      await lib.put(url, new Response(blob, { headers: { "Content-Type": res.headers.get("Content-Type") || "application/json" } }));
    } catch (err) {
      if (!/HTTP 404/.test(err.message)) throw err;
    }
  }

  const sizes = await fileSizes(repo);
  const onnx = [
    `onnx/encoder_model${SUFFIX[dtype.encoder_model]}.onnx`,
    `onnx/decoder_model_merged${SUFFIX[dtype.decoder_model_merged]}.onnx`,
  ];
  const total = onnx.reduce((s, p) => s + (sizes[p] || 0), 0);
  let done = 0;
  const report = (extra = 0) => self.postMessage({
    type: "download", loaded: done + extra, total, percent: Math.min(100, Math.round(((done + extra) / total) * 100)),
  });

  for (const path of onnx) {
    const url = fileUrl(repo, path);
    const size = sizes[path];
    if (!size) throw new Error("ملف النموذج غير موجود: " + path);
    if (await lib.match(url)) { done += size; report(); continue; }

    const count = Math.ceil(size / PART);
    const blobs = [];
    for (let i = 0; i < count; i++) {
      const key = `${url}?part=${i}`;
      let piece = await parts.match(key);
      if (piece) {
        blobs.push(await piece.blob());
      } else {
        const start = i * PART, end = Math.min(size, start + PART) - 1;
        const before = blobs.reduce((s, b) => s + b.size, 0);
        const { res, blob } = await fetchRetry(url, { headers: { Range: `bytes=${start}-${end}` } }, 8,
          (n) => report(before + n));
        if (res.status !== 206 && count > 1) throw new Error("الخادم لا يدعم التنزيل على أجزاء");
        if (blob.size !== end - start + 1) throw new Error("NetworkError: جزء ناقص");
        await parts.put(key, new Response(blob));
        blobs.push(blob);
      }
      report(blobs.reduce((s, b) => s + b.size, 0));
    }
    // جمع الأجزاء في ملف واحد بصيغة تفهمها المكتبة، ثم حذف الأجزاء لتوفير المساحة
    const full = new Blob(blobs, { type: "application/octet-stream" });
    await lib.put(url, new Response(full, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(full.size) } }));
    for (let i = 0; i < count; i++) await parts.delete(`${url}?part=${i}`);
    done += size;
    report();
  }
}

/** تحميل النموذج: تنزيل مضمون أولاً، ثم إنشاء محرك التفريغ من الذاكرة المحلية */
async function load(model) {
  const { webgpu } = await detectGpu();
  if (model === "turbo" && !webgpu) model = "small"; // النموذج الكبير يحتاج معالج رسوميات
  const devices = webgpu ? ["webgpu", "wasm"] : ["wasm"];
  for (const device of devices) {
    const key = model + ":" + device;
    if (asr && loadedKey === key) return { model, device };
    try {
      await ensureCached(MODELS[model], dtypeFor(model, device));
    } catch (err) {
      throw new Error((isNetworkError(err) ? "NETWORK: " : "") + (err && err.message || err));
    }
    try {
      if (asr) { await asr.dispose?.(); asr = null; }
      self.postMessage({ type: "stage", stage: "loading" });
      asr = await pipeline("automatic-speech-recognition", MODELS[model], { device, dtype: dtypeFor(model, device) });
      loadedKey = key;
      return { model, device };
    } catch (err) {
      asr = null;
      if (isNetworkError(err)) throw new Error("NETWORK: " + (err && err.message || err));
      if (device === "wasm") throw err;
      console.warn("WebGPU failed, falling back to WASM:", err); // عطل حقيقي في WebGPU فقط
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
