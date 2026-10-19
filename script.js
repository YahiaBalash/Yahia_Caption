/* =========================================================
   كابشن AI — منطق الواجهة
   الواجهة لا تحتوي أي مفتاح API؛ كل المعالجة تتم في الخادم (server/app.py).
   ========================================================= */
"use strict";

// ---------- الإعدادات العامة ----------
const CONFIG = {
  // غيّر اسم الموقع من هنا فقط
  SITE_NAME: "كابشن AI",
  // عنوان الخادم: فارغ = نفس العنوان. عند فتح index.html مباشرة من الجهاز نتصل بالخادم المحلي.
  API_BASE: location.protocol === "file:" ? "http://localhost:5000" : "",
  POLL_INTERVAL_MS: 1500,
  // حدود تقريبية آمنة لطول النص في روابط المشاركة
  SHARE_LIMITS: { whatsapp: 3000, telegram: 3500, email: 1800 },
  FONT_MIN: 14,
  FONT_MAX: 32,
};

const ALLOWED_EXT = ["mp4", "webm", "mov", "m4v", "mkv", "mp3", "m4a", "wav", "ogg"];

const SOURCE_LABELS = {
  official_captions: "ترجمة رسمية من صاحب الفيديو",
  auto_captions: "ترجمة تلقائية من المنصة",
  speech_to_text: "تفريغ الكلام (Speech-to-Text)",
};

const LANG_NAMES = {
  ar: "العربية", arabic: "العربية", en: "الإنجليزية", english: "الإنجليزية", fr: "الفرنسية", french: "الفرنسية",
  es: "الإسبانية", spanish: "الإسبانية", de: "الألمانية", german: "الألمانية", tr: "التركية", turkish: "التركية",
  ur: "الأردية", urdu: "الأردية", fa: "الفارسية", persian: "الفارسية", id: "الإندونيسية", indonesian: "الإندونيسية",
};

// ---------- الحالة ----------
const state = {
  server: null,          // نتيجة /api/health
  file: null,            // الملف المختار
  previewUrl: null,
  lastRequest: null,     // آخر طلب لإعادة المحاولة
  result: null,          // نتيجة الاستخراج من الخادم
  originalText: "",
  busy: false,
  fontSize: 19,
};

// ---------- اختصارات ----------
const $ = (id) => document.getElementById(id);
const els = {
  serverStatus: $("serverStatus"),
  tabs: document.querySelectorAll(".tab"),
  panelUrl: $("panel-url"),
  panelFile: $("panel-file"),
  videoUrl: $("videoUrl"),
  platformBadge: $("platformBadge"),
  extractUrlBtn: $("extractUrlBtn"),
  dropzone: $("dropzone"),
  dropLimit: $("dropLimit"),
  fileInput: $("fileInput"),
  fileInfo: $("fileInfo"),
  fileName: $("fileName"),
  fileSize: $("fileSize"),
  videoPreview: $("videoPreview"),
  removeFileBtn: $("removeFileBtn"),
  extractFileBtn: $("extractFileBtn"),
  language: $("language"),
  mode: $("mode"),
  modeOption: $("modeOption"),
  inputError: $("inputError"),
  progressCard: $("progressCard"),
  progressStage: $("progressStage"),
  progressBar: $("progressBar"),
  elapsed: $("elapsed"),
  resultSection: $("resultSection"),
  sourceBadge: $("sourceBadge"),
  langBadge: $("langBadge"),
  platformMeta: $("platformMeta"),
  durationMeta: $("durationMeta"),
  metaTitle: $("metaTitle"),
  metaDescWrap: $("metaDescWrap"),
  metaDesc: $("metaDesc"),
  copyDescBtn: $("copyDescBtn"),
  warnings: $("warnings"),
  transcript: $("transcript"),
  highlights: $("highlights"),
  searchInput: $("searchInput"),
  searchCount: $("searchCount"),
  searchPrev: $("searchPrev"),
  searchNext: $("searchNext"),
  wordCount: $("wordCount"),
  charCount: $("charCount"),
  editedNote: $("editedNote"),
  fontUp: $("fontUp"),
  fontDown: $("fontDown"),
  copyBtn: $("copyBtn"),
  txtBtn: $("txtBtn"),
  srtBtn: $("srtBtn"),
  editBtn: $("editBtn"),
  formatBtn: $("formatBtn"),
  restoreBtn: $("restoreBtn"),
  retryBtn: $("retryBtn"),
  clearBtn: $("clearBtn"),
  shareNote: $("shareNote"),
  shareNoteText: $("shareNoteText"),
  shareCopyFull: $("shareCopyFull"),
  shareExcerpt: $("shareExcerpt"),
  deviceShareBtn: $("deviceShareBtn"),
  confirmDialog: $("confirmDialog"),
  toasts: $("toasts"),
};

// =========================================================
// أدوات عامة
// =========================================================
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " بايت";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " كيلوبايت";
  return (bytes / 1024 / 1024).toFixed(1) + " ميغابايت";
}

function formatDuration(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = h ? String(m).padStart(2, "0") : m;
  return (h ? h + ":" : "") + mm + ":" + String(s).padStart(2, "0");
}

function toast(message, type = "success") {
  const el = document.createElement("div");
  el.className = "toast " + type;
  const icon = type === "error" ? "i-alert" : type === "info" ? "i-info" : "i-check";
  el.innerHTML = `<svg class="ic"><use href="#${icon}"/></svg><span></span>`;
  el.querySelector("span").textContent = message;
  els.toasts.appendChild(el);
  setTimeout(() => { el.classList.add("hide"); setTimeout(() => el.remove(), 300); }, 3200);
}

function showInputError(message) {
  els.inputError.querySelector("span").textContent = message;
  els.inputError.hidden = false;
}
function hideInputError() {
  els.inputError.hidden = true;
  els.videoUrl.classList.remove("invalid");
}

/** نسخ إلى الحافظة مع بديل للمتصفحات القديمة */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* ننتقل إلى البديل */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
  ta.remove();
  return ok;
}

/** تنزيل ملف نصي بترميز UTF-8 مع BOM حتى تظهر العربية بشكل صحيح في كل البرامج */
function downloadFile(content, filename, mime) {
  const blob = new Blob(["﻿" + content], { type: mime + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilename(name) {
  const base = (name || "transcript").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80);
  return base || "transcript";
}

function isRtlText(text) {
  const rtl = (text.match(/[֐-ࣿיִ-﷿ﹰ-﻿]/g) || []).length;
  const ltr = (text.match(/[A-Za-zÀ-ɏ]/g) || []).length;
  return rtl >= ltr;
}

// =========================================================
// فحص الخادم
// =========================================================
async function checkServer() {
  const pill = els.serverStatus;
  const set = (cls, text, title) => {
    pill.className = "status-pill " + cls;
    pill.querySelector(".status-text").textContent = text;
    pill.title = title || text;
  };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(CONFIG.API_BASE + "/api/health", { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error();
    state.server = await res.json();
    els.dropLimit.textContent = `الحد الأقصى ${state.server.max_upload_mb} ميغابايت و${state.server.max_duration_min} دقيقة`;
    if (state.server.stt_ready) {
      set("status-ok", "الخادم متصل · " + state.server.stt_message);
    } else {
      set("status-warn", "متصل · تفريغ الصوت غير مُعدّ",
          state.server.stt_message + " — يمكن استخراج الترجمات الموجودة فقط. راجع README.");
    }
  } catch (_) {
    state.server = null;
    set("status-down", "الخادم غير متصل", "شغّل الخادم: python server/app.py (راجع README)");
  }
}

// =========================================================
// التبويبات
// =========================================================
function switchTab(name) {
  els.tabs.forEach((t) => {
    const active = t.dataset.tab === name;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", active);
  });
  els.panelUrl.hidden = name !== "url";
  els.panelFile.hidden = name !== "file";
  els.modeOption.hidden = name !== "url"; // طريقة الاستخراج تخص الروابط فقط
  hideInputError();
}
els.tabs.forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

// =========================================================
// التحقق من الرابط
// =========================================================
const PLATFORMS = [
  { name: "YouTube", re: /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i },
  { name: "Facebook", re: /(^|\.)(facebook\.com|fb\.watch|fb\.com)$/i },
  { name: "Instagram", re: /(^|\.)instagram\.com$/i },
  { name: "TikTok", re: /(^|\.)tiktok\.com$/i },
  { name: "X", re: /(^|\.)(twitter\.com|x\.com)$/i },
  { name: "Vimeo", re: /(^|\.)vimeo\.com$/i },
  { name: "Dailymotion", re: /(^|\.)(dailymotion\.com|dai\.ly)$/i },
];

/** يعيد {ok, url, platform, error} */
function validateUrl(raw) {
  const value = raw.trim();
  if (!value) return { ok: false, error: "أدخل رابط الفيديو أولاً." };
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(value) ? value : "https://" + value);
  } catch (_) {
    return { ok: false, error: "الرابط غير صحيح. تأكد من نسخه كاملاً، مثل: https://www.youtube.com/watch?v=..." };
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return { ok: false, error: "يجب أن يبدأ الرابط بـ http:// أو https://" };
  }
  if (!url.hostname.includes(".") || /\s/.test(value)) {
    return { ok: false, error: "الرابط غير صحيح. تأكد من نسخه كاملاً." };
  }
  if (/^(localhost|127\.|10\.|192\.168\.|0\.)/.test(url.hostname)) {
    return { ok: false, error: "الروابط المحلية غير مدعومة. أدخل رابط فيديو منشور على الإنترنت." };
  }
  const host = url.hostname.replace(/^www\.|^m\./, "");
  const platform = PLATFORMS.find((p) => p.re.test(host));

  if (platform && platform.name === "YouTube") {
    const isVideo = /youtu\.be$/.test(host) ? url.pathname.length > 1
      : url.searchParams.has("v") || /^\/(shorts|live|embed|v)\/[\w-]+/.test(url.pathname);
    if (!isVideo) {
      return { ok: false, error: "هذا ليس رابط فيديو على YouTube (قد يكون رابط قناة أو قائمة تشغيل). افتح الفيديو وانسخ رابطه." };
    }
  }
  return { ok: true, url: url.href, platform: platform ? platform.name : null };
}

els.videoUrl.addEventListener("input", () => {
  hideInputError();
  const v = validateUrl(els.videoUrl.value);
  if (v.ok) {
    els.platformBadge.textContent = v.platform || "موقع آخر";
    els.platformBadge.hidden = false;
    els.videoUrl.classList.add("has-badge");
  } else {
    els.platformBadge.hidden = true;
    els.videoUrl.classList.remove("has-badge");
  }
});
els.videoUrl.addEventListener("keydown", (e) => { if (e.key === "Enter") startUrlExtraction(); });
els.extractUrlBtn.addEventListener("click", startUrlExtraction);

// =========================================================
// رفع الملف
// =========================================================
function selectFile(file) {
  hideInputError();
  if (!file) return;
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) {
    showInputError(`صيغة الملف «${ext || "غير معروفة"}» غير مدعومة. الصيغ المسموحة: ${ALLOWED_EXT.join("، ").toUpperCase()}`);
    els.fileInput.value = "";
    return;
  }
  const maxMb = state.server ? state.server.max_upload_mb : 200;
  if (file.size > maxMb * 1024 * 1024) {
    showInputError(`حجم الملف (${formatBytes(file.size)}) أكبر من الحد المسموح (${maxMb} ميغابايت).`);
    els.fileInput.value = "";
    return;
  }
  if (file.size === 0) {
    showInputError("الملف فارغ.");
    return;
  }
  state.file = file;
  els.fileName.textContent = file.name;
  els.fileSize.textContent = formatBytes(file.size);

  // معاينة الفيديو إن أمكن
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(file);
  const canPreview = file.type.startsWith("video/") || file.type.startsWith("audio/") || ["mp4", "webm", "mov", "m4v"].includes(ext);
  els.videoPreview.hidden = !canPreview;
  if (canPreview) els.videoPreview.src = state.previewUrl;
  els.videoPreview.onerror = () => { els.videoPreview.hidden = true; }; // بعض صيغ MOV/MKV لا يعرضها المتصفح

  els.fileInfo.hidden = false;
  els.dropzone.hidden = true;
}

function removeFile() {
  state.file = null;
  els.fileInput.value = "";
  els.videoPreview.removeAttribute("src");
  els.videoPreview.load();
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  els.fileInfo.hidden = true;
  els.dropzone.hidden = false;
}

els.fileInput.addEventListener("change", () => selectFile(els.fileInput.files[0]));
els.removeFileBtn.addEventListener("click", removeFile);
els.extractFileBtn.addEventListener("click", startFileExtraction);
els.dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.fileInput.click(); }
});
["dragenter", "dragover"].forEach((ev) => els.dropzone.addEventListener(ev, (e) => {
  e.preventDefault();
  els.dropzone.classList.add("dragover");
}));
["dragleave", "drop"].forEach((ev) => els.dropzone.addEventListener(ev, (e) => {
  e.preventDefault();
  els.dropzone.classList.remove("dragover");
}));
els.dropzone.addEventListener("drop", (e) => selectFile(e.dataTransfer.files[0]));
// منع المتصفح من فتح الملف إذا أُفلت خارج المنطقة
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// =========================================================
// الاتصال بالخادم ومتابعة المهمة
// =========================================================
let elapsedTimer = null;

function setBusy(busy) {
  state.busy = busy;
  [els.extractUrlBtn, els.extractFileBtn, els.retryBtn].forEach((b) => (b.disabled = busy));
  els.progressCard.hidden = !busy;
  showLivePreview("");
  clearInterval(elapsedTimer);
  if (busy) {
    const start = Date.now();
    els.elapsed.textContent = "0:00";
    elapsedTimer = setInterval(() => (els.elapsed.textContent = formatDuration((Date.now() - start) / 1000)), 1000);
    els.progressCard.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function setProgress(stage, percent) {
  els.progressStage.textContent = stage;
  if (typeof percent === "number") {
    els.progressBar.classList.remove("indeterminate");
    els.progressBar.style.width = Math.max(2, Math.min(100, percent)) + "%";
  } else {
    els.progressBar.classList.add("indeterminate");
    els.progressBar.style.width = "";
  }
}

/** يعرض النص المفرَّغ حتى الآن، ويبقي آخره ظاهراً ما لم يمرّر المستخدم للأعلى ليقرأ */
function showLivePreview(text) {
  const box = $("liveText");
  if (!text) { $("livePreview").hidden = true; return; }
  if (box.textContent === text) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.textContent = text;
  $("livePreview").hidden = false;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

const SERVER_DOWN_MSG = ["localhost", "127.0.0.1", "[::1]", ""].includes(location.hostname)
  ? "تعذّر الاتصال بالخادم. تأكد من تشغيله (python server/app.py) ومن اتصالك بالإنترنت، ثم أعد المحاولة."
  : "تعذّر الاتصال بالحاسوب الذي يشغّل الخادم. تأكد أنه يعمل وأن هاتفك على نفس شبكة الواي فاي، ثم أعد المحاولة.";

/** يرسل طلب رابط ويعيد job_id */
async function postUrl(req) {
  let res;
  try {
    res = await fetch(CONFIG.API_BASE + "/api/transcribe/url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: req.url, language: req.language, mode: req.mode }),
    });
  } catch (_) {
    throw new Error(SERVER_DOWN_MSG);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "رفض الخادم الطلب.");
  return data.job_id;
}

/** يرفع الملف مع إظهار نسبة الرفع الحقيقية ويعيد job_id */
function postFile(req) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", req.file);
    form.append("language", req.language);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", CONFIG.API_BASE + "/api/transcribe/file");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const p = Math.round((e.loaded / e.total) * 100);
        setProgress(`جارٍ رفع الملف… ${p}%`, p);
      }
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (_) { /* تجاهل */ }
      if (xhr.status >= 200 && xhr.status < 300 && data.job_id) resolve(data.job_id);
      else reject(new Error(data.error || `رفض الخادم الملف (رمز ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error(SERVER_DOWN_MSG));
    xhr.send(form);
  });
}

/** يتابع حالة المهمة حتى تنتهي */
async function pollJob(jobId) {
  let failures = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, CONFIG.POLL_INTERVAL_MS));
    let job;
    try {
      const res = await fetch(CONFIG.API_BASE + "/api/jobs/" + jobId, { cache: "no-store" });
      job = await res.json();
      if (!res.ok) throw Object.assign(new Error(job.error || "تعذّرت متابعة المهمة."), { fatal: true });
      failures = 0;
    } catch (err) {
      if (err.fatal) throw err;
      if (++failures >= 4) throw new Error("انقطع الاتصال بالخادم أثناء المعالجة. تحقق من اتصالك ثم أعد المحاولة.");
      setProgress("الاتصال ضعيف… نعيد المحاولة", null);
      continue;
    }
    if (job.status === "done") return job.result;
    if (job.status === "error") throw new Error(job.error);
    setProgress(job.stage || "جارٍ المعالجة…", job.progress);
    showLivePreview(job.partial);
  }
}

async function runExtraction(req) {
  if (state.busy) return;
  hideInputError();
  state.lastRequest = req;
  setBusy(true);
  setProgress(req.type === "file" ? "جارٍ رفع الملف…" : "جارٍ إرسال الرابط…", req.type === "file" ? 0 : null);
  try {
    const jobId = req.type === "file" ? await postFile(req) : await postUrl(req);
    setProgress("جارٍ المعالجة…", null);
    const result = await pollJob(jobId);
    showResult(result);
    toast("تم استخراج النص بنجاح");
  } catch (err) {
    showInputError(err.message || "حدث خطأ غير متوقع.");
    els.inputError.scrollIntoView({ behavior: "smooth", block: "center" });
    checkServer();
  } finally {
    setBusy(false);
  }
}

function startUrlExtraction() {
  const v = validateUrl(els.videoUrl.value);
  if (!v.ok) {
    els.videoUrl.classList.add("invalid");
    showInputError(v.error);
    els.videoUrl.focus();
    return;
  }
  runExtraction({ type: "url", url: v.url, language: els.language.value, mode: els.mode.value });
}

function startFileExtraction() {
  if (!state.file) {
    showInputError("اختر ملف فيديو أولاً.");
    return;
  }
  runExtraction({ type: "file", file: state.file, language: els.language.value });
}

// =========================================================
// عرض النتيجة
// =========================================================
function showResult(result) {
  state.result = result;
  state.originalText = result.text || "";

  els.sourceBadge.textContent = SOURCE_LABELS[result.source] || "نص مستخرج";
  const lang = (result.language || "").toLowerCase();
  els.langBadge.hidden = !lang;
  els.langBadge.textContent = "اللغة: " + (LANG_NAMES[lang] || lang);

  const meta = result.meta || {};
  els.platformMeta.hidden = !meta.platform;
  els.platformMeta.textContent = meta.platform || "";
  els.durationMeta.hidden = !meta.duration;
  els.durationMeta.textContent = meta.duration ? "المدة: " + formatDuration(meta.duration) : "";
  els.metaTitle.textContent = meta.title || "";
  els.metaDescWrap.hidden = !meta.description;
  els.metaDesc.textContent = meta.description || "";

  els.warnings.innerHTML = "";
  (result.warnings || []).forEach((w) => {
    const div = document.createElement("div");
    div.className = "alert alert-warn";
    div.innerHTML = '<svg class="ic"><use href="#i-alert"/></svg><span></span>';
    div.querySelector("span").textContent = w;
    els.warnings.appendChild(div);
  });

  setTranscript(state.originalText);
  els.srtBtn.disabled = !result.has_timestamps;
  els.srtBtn.title = result.has_timestamps ? "" : "لا تتوفر بيانات توقيت لهذا النص";
  els.shareNote.hidden = true;
  els.resultSection.hidden = false;
  els.resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setTranscript(text) {
  els.transcript.value = text;
  els.transcript.dir = els.highlights.dir = isRtlText(text) ? "rtl" : "ltr";
  updateCounts();
  runSearch(false);
}

function getText() {
  return els.transcript.value.trim();
}

function updateCounts() {
  const text = els.transcript.value;
  const trimmed = text.trim();
  els.wordCount.textContent = (trimmed ? trimmed.split(/\s+/).length : 0).toLocaleString("ar-EG");
  els.charCount.textContent = [...text].length.toLocaleString("ar-EG");
  const edited = state.result && text !== state.originalText;
  els.restoreBtn.disabled = !edited;
  els.editedNote.hidden = !(edited && state.result && state.result.has_timestamps);
}

let searchDebounce = null;
els.transcript.addEventListener("input", () => {
  updateCounts();
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runSearch(false), 150);
});

// =========================================================
// البحث داخل النص
// يتجاهل التشكيل والتطويل، ويوحّد أشكال الألف (أ إ آ ٱ ← ا) والياء (ى ← ي) والتاء المربوطة (ة ← ه)
// والهمزات (ؤ ← و، ئ ← ي)، ولا يفرّق بين الأحرف الكبيرة والصغيرة.
// =========================================================
const AR_DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/;
const AR_NORMAL = { "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي" };
const search = { matches: [], current: -1 };

function normalizeChar(c) {
  if (AR_NORMAL[c]) return AR_NORMAL[c];
  if (/\s/.test(c)) return " ";
  const lower = c.toLowerCase();
  return lower.length === 1 ? lower : c;
}

/** يبني نسخة مطبّعة من النص مع خريطة من كل موضع فيها إلى موضعه في النص الأصلي */
function normalizeWithMap(text) {
  let norm = "";
  const map = [];
  for (let i = 0; i < text.length; i++) {
    if (AR_DIACRITICS.test(text[i])) continue;
    norm += normalizeChar(text[i]);
    map.push(i);
  }
  return { norm, map };
}

function findMatches(text, query) {
  const q = normalizeWithMap(query.trim()).norm.replace(/ +/g, " ");
  if (!q) return [];
  const { norm, map } = normalizeWithMap(text);
  const found = [];
  let from = 0, idx;
  while ((idx = norm.indexOf(q, from)) !== -1) {
    const start = map[idx];
    let end = map[idx + q.length - 1] + 1;
    while (end < text.length && AR_DIACRITICS.test(text[end])) end++; // ضمّ تشكيل آخر حرف
    found.push([start, end]);
    from = idx + q.length;
  }
  return found;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function renderHighlights() {
  const text = els.transcript.value;
  if (!search.matches.length) {
    els.highlights.textContent = "";
    return;
  }
  let html = "", last = 0;
  search.matches.forEach(([s, e], i) => {
    html += escapeHtml(text.slice(last, s)) +
      `<mark${i === search.current ? ' class="current"' : ""}>${escapeHtml(text.slice(s, e))}</mark>`;
    last = e;
  });
  // سطر إضافي حتى يطابق ارتفاعُ الطبقة ارتفاعَ النص عندما ينتهي بسطر فارغ
  els.highlights.innerHTML = html + escapeHtml(text.slice(last)) + "\n ";
  syncHighlightScroll();
}

function syncHighlightScroll() {
  els.highlights.scrollTop = els.transcript.scrollTop;
  els.highlights.scrollLeft = els.transcript.scrollLeft;
}

function updateSearchUi() {
  const q = els.searchInput.value.trim();
  const n = search.matches.length;
  els.searchPrev.disabled = els.searchNext.disabled = n === 0;
  els.searchCount.classList.toggle("none", !!q && n === 0);
  els.searchCount.textContent = !q ? "" : n === 0 ? "لا نتائج"
    : `${(search.current + 1).toLocaleString("ar-EG")} من ${n.toLocaleString("ar-EG")}`;
}

/** يمرّر صندوق النص حتى تظهر النتيجة الحالية في الثلث العلوي منه */
function scrollToCurrent() {
  const mark = els.highlights.querySelector("mark.current");
  if (!mark) return;
  els.transcript.scrollTop = Math.max(0, mark.offsetTop - els.transcript.clientHeight / 3);
  syncHighlightScroll();
}

/** يعيد البحث؛ jump=true ينقل إلى أول نتيجة، وإلا يحافظ على الموضع الحالي قدر الإمكان */
function runSearch(jump) {
  const q = els.searchInput.value;
  search.matches = q.trim() ? findMatches(els.transcript.value, q) : [];
  if (!search.matches.length) search.current = -1;
  else if (jump || search.current < 0) search.current = 0;
  else search.current = Math.min(search.current, search.matches.length - 1);
  renderHighlights();
  updateSearchUi();
  if (jump) scrollToCurrent();
}

function stepSearch(delta) {
  const n = search.matches.length;
  if (!n) return;
  search.current = (search.current + delta + n) % n;
  renderHighlights();
  updateSearchUi();
  scrollToCurrent();
}

els.searchInput.addEventListener("input", () => runSearch(true));
els.searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); stepSearch(e.shiftKey ? -1 : 1); }
  else if (e.key === "Escape") { els.searchInput.value = ""; runSearch(false); els.transcript.focus(); }
});
els.searchNext.addEventListener("click", () => stepSearch(1));
els.searchPrev.addEventListener("click", () => stepSearch(-1));
els.transcript.addEventListener("scroll", syncHighlightScroll);
// Ctrl+F يفتح بحث النص عندما تكون النتيجة معروضة
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && !els.resultSection.hidden) {
    e.preventDefault();
    els.searchInput.focus();
    els.searchInput.select();
  }
});

// =========================================================
// أزرار النص
// =========================================================
function requireText() {
  const text = getText();
  if (!text) {
    toast("لا يوجد نص بعد", "error");
    return null;
  }
  return text;
}

els.copyBtn.addEventListener("click", async () => {
  const text = requireText();
  if (!text) return;
  const ok = await copyText(text);
  toast(ok ? "تم نسخ النص كاملاً" : "تعذّر النسخ، حدّد النص وانسخه يدوياً", ok ? "success" : "error");
});

els.txtBtn.addEventListener("click", () => {
  const text = requireText();
  if (!text) return;
  const name = safeFilename(state.result && state.result.meta && state.result.meta.title);
  downloadFile(text.replace(/\r?\n/g, "\r\n") + "\r\n", name + ".txt", "text/plain");
  toast("تم تحميل ملف TXT");
});

/** يحوّل الثواني إلى صيغة SRT: 00:01:02,345 */
function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

function buildSrt(segments) {
  return segments
    .filter((s) => s.text && s.text.trim())
    .map((s, i) => `${i + 1}\r\n${srtTime(s.start)} --> ${srtTime(Math.max(s.end, s.start + 0.5))}\r\n${s.text.trim()}\r\n`)
    .join("\r\n");
}

els.srtBtn.addEventListener("click", () => {
  if (!state.result || !state.result.has_timestamps || !state.result.segments.length) {
    toast("لا تتوفر بيانات توقيت لإنشاء ملف SRT", "error");
    return;
  }
  const name = safeFilename(state.result.meta && state.result.meta.title);
  downloadFile(buildSrt(state.result.segments), name + ".srt", "application/x-subrip");
  toast(els.transcript.value !== state.originalText
    ? "تم تحميل SRT (من التفريغ الأصلي بتوقيتاته)"
    : "تم تحميل ملف SRT");
});

els.editBtn.addEventListener("click", () => {
  els.transcript.focus();
  els.transcript.setSelectionRange(els.transcript.value.length, els.transcript.value.length);
  els.transcript.classList.remove("flash");
  void els.transcript.offsetWidth;
  els.transcript.classList.add("flash");
  toast("يمكنك الآن التعديل مباشرة داخل الصندوق", "info");
});

/**
 * تنسيق النص دون تغيير المعنى:
 * - توحيد المسافات وإزالة المسافة قبل علامات الترقيم وإضافتها بعدها.
 * - تحويل الفاصلة وعلامة الاستفهام اللاتينية إلى العربية بعد الحروف العربية.
 * - دمج الأسطر المكسورة وتقسيم النص إلى فقرات متوسطة الطول عند نهايات الجمل.
 */
function formatText(text) {
  const AR = "؀-ۿ";
  const paragraphs = text.replace(/\r/g, "").split(/\n\s*\n+/).map((p) => {
    let s = p.replace(/\s*\n\s*/g, " ").replace(/[ \t ]+/g, " ").trim();
    s = s.replace(new RegExp(`([${AR}])\\s*,`, "g"), "$1،")
         .replace(new RegExp(`([${AR}])\\s*\\?`, "g"), "$1؟")
         .replace(new RegExp(`([${AR}])\\s*;`, "g"), "$1؛");
    s = s.replace(/\s+([،؛؟,.!?:;…])/g, "$1");                       // لا مسافة قبل العلامة
    s = s.replace(/([،؛؟!…])(?=[^\s\d،؛؟!.…"'»)\]])/g, "$1 ");        // مسافة بعد العلامات العربية
    s = s.replace(new RegExp(`([.,:;?])(?=[${AR}])`, "g"), "$1 ");    // مسافة بعد اللاتينية قبل حرف عربي
    s = s.replace(/([^.])\.{2}(?!\.)/g, "$1.");                       // نقطتان مكررتان سهواً
    return s;
  }).filter(Boolean);

  // تقسيم الفقرات الطويلة جداً عند نهايات الجمل
  const out = [];
  paragraphs.forEach((p) => {
    if (p.length <= 650) { out.push(p); return; }
    const sentences = p.match(/[^.!?؟…]+(?:[.!?؟…]+["»”')]*\s*|$)/g) || [p];
    let cur = "";
    sentences.forEach((sen) => {
      if (cur.length >= 450) { out.push(cur.trim()); cur = ""; }
      cur += sen;
    });
    if (cur.trim()) out.push(cur.trim());
  });
  return out.join("\n\n");
}

els.formatBtn.addEventListener("click", () => {
  const text = requireText();
  if (!text) return;
  const formatted = formatText(els.transcript.value);
  if (formatted === els.transcript.value) {
    toast("النص منسّق بالفعل", "info");
    return;
  }
  setTranscript(formatted);
  toast("تم تنسيق النص — يمكنك التراجع بزر «استعادة الأصل»");
});

els.restoreBtn.addEventListener("click", () => {
  setTranscript(state.originalText);
  toast("تمت استعادة النص الأصلي");
});

els.retryBtn.addEventListener("click", () => {
  if (!state.lastRequest) {
    toast("لا يوجد طلب سابق لإعادته", "error");
    return;
  }
  runExtraction(state.lastRequest);
});

els.clearBtn.addEventListener("click", () => {
  if (typeof els.confirmDialog.showModal === "function") {
    els.confirmDialog.returnValue = "";
    els.confirmDialog.showModal();
  } else if (confirm("هل تريد مسح النص الحالي؟")) {
    clearContent();
  }
});
els.confirmDialog.addEventListener("close", () => {
  if (els.confirmDialog.returnValue === "confirm") clearContent();
});

function clearContent() {
  state.result = null;
  state.originalText = "";
  els.searchInput.value = "";
  setTranscript("");
  els.resultSection.hidden = true;
  els.shareNote.hidden = true;
  toast("تم مسح المحتوى");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

els.copyDescBtn.addEventListener("click", async () => {
  const ok = await copyText(els.metaDesc.textContent);
  toast(ok ? "تم نسخ الوصف" : "تعذّر النسخ", ok ? "success" : "error");
});

// حجم الخط
function applyFont() {
  document.documentElement.style.setProperty("--transcript-size", state.fontSize + "px");
  els.fontDown.disabled = state.fontSize <= CONFIG.FONT_MIN;
  els.fontUp.disabled = state.fontSize >= CONFIG.FONT_MAX;
  try { localStorage.setItem("captionai.font", state.fontSize); } catch (_) { /* تجاهل */ }
}
els.fontUp.addEventListener("click", () => { state.fontSize = Math.min(CONFIG.FONT_MAX, state.fontSize + 2); applyFont(); });
els.fontDown.addEventListener("click", () => { state.fontSize = Math.max(CONFIG.FONT_MIN, state.fontSize - 2); applyFont(); });

// =========================================================
// المشاركة
// =========================================================
let pendingExcerpt = null;

function openShare(url) {
  const w = window.open(url, "_blank", "noopener,noreferrer");
  if (!w) toast("منع المتصفح فتح نافذة جديدة؛ اسمح بالنوافذ المنبثقة لهذا الموقع", "error");
}

function shareUrlFor(platform, text) {
  const enc = encodeURIComponent;
  const videoUrl = state.result && state.result.meta && state.result.meta.webpage_url;
  switch (platform) {
    case "whatsapp":
      return "https://wa.me/?text=" + enc(text);
    case "telegram":
      return videoUrl
        ? `https://t.me/share/url?url=${enc(videoUrl)}&text=${enc(text)}`
        : `https://t.me/share/url?url=${enc(text)}`;
    case "email": {
      const subject = (state.result && state.result.meta && state.result.meta.title) || "نص مستخرج من فيديو";
      return `mailto:?subject=${enc(subject)}&body=${enc(text.replace(/\r?\n/g, "\r\n"))}`;
    }
  }
  return null;
}

function excerpt(text, limit) {
  const cut = text.slice(0, limit - 20);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > limit * 0.7 ? cut.slice(0, lastSpace) : cut) + " …";
}

function showShareNote(message, excerptAction) {
  els.shareNoteText.textContent = message;
  pendingExcerpt = excerptAction || null;
  els.shareExcerpt.hidden = !excerptAction;
  if (excerptAction) els.shareExcerpt.textContent = excerptAction.label;
  els.shareNote.hidden = false;
}

async function share(platform) {
  const text = requireText();
  if (!text) return;
  els.shareNote.hidden = true;

  if (platform === "facebook") {
    // فيسبوك لا يسمح بتعبئة نص المنشور مسبقاً عبر رابط المشاركة الرسمي
    const ok = await copyText(text);
    const videoUrl = state.result && state.result.meta && state.result.meta.webpage_url;
    openShare(videoUrl
      ? "https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(videoUrl)
      : "https://www.facebook.com/");
    showShareNote((ok ? "تم نسخ النص. " : "") +
      "فيسبوك لا يسمح بإدراج النص تلقائياً في المنشور؛ الصق النص يدوياً (Ctrl+V) في نافذة النشر التي فُتحت.");
    return;
  }

  if (platform === "instagram") {
    const ok = await copyText(text);
    showShareNote(ok
      ? "تم نسخ النص كاملاً. Instagram لا يوفّر رابط مشاركة نصياً من المتصفح؛ افتح التطبيق والصق النص في الوصف أو الرسالة."
      : "تعذّر النسخ التلقائي؛ حدّد النص من الصندوق وانسخه يدوياً.");
    return;
  }

  if (platform === "device") {
    try {
      await navigator.share({ title: (state.result && state.result.meta && state.result.meta.title) || CONFIG.SITE_NAME, text });
    } catch (err) {
      if (err.name !== "AbortError") toast("تعذّرت المشاركة عبر الجهاز", "error");
    }
    return;
  }

  const limit = CONFIG.SHARE_LIMITS[platform];
  if (text.length > limit) {
    const names = { whatsapp: "WhatsApp", telegram: "Telegram", email: "البريد الإلكتروني" };
    showShareNote(
      `النص طويل (${text.length.toLocaleString("ar-EG")} حرف) ولا يمكن إرساله كاملاً عبر رابط مشاركة ${names[platform]} ` +
      `(الحد التقريبي ${limit.toLocaleString("ar-EG")} حرف). انسخه كاملاً والصقه في المحادثة، أو شارك مقتطفاً من بدايته.`,
      { label: `مشاركة مقتطف عبر ${names[platform]}`, run: () => openShare(shareUrlFor(platform, excerpt(text, limit))) }
    );
    return;
  }
  if (platform === "email") location.href = shareUrlFor(platform, text);
  else openShare(shareUrlFor(platform, text));
}

document.querySelectorAll("[data-share]").forEach((b) => b.addEventListener("click", () => share(b.dataset.share)));
els.shareCopyFull.addEventListener("click", async () => {
  const text = getText();
  const ok = text && (await copyText(text));
  toast(ok ? "تم نسخ النص كاملاً" : "تعذّر النسخ", ok ? "success" : "error");
});
els.shareExcerpt.addEventListener("click", () => pendingExcerpt && pendingExcerpt.run());

// =========================================================
// تطبيق الهاتف (PWA): التثبيت، والفتح من الهاتف، واستقبال الروابط المُشارَكة
// =========================================================
const isLocalHost = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
let installPrompt = null;

function registerServiceWorker() {
  // عامل الخدمة يعمل فقط في سياق آمن (localhost أو HTTPS أو عنوان مسموح عبر chrome://flags)
  if (!("serviceWorker" in navigator) || !window.isSecureContext || location.protocol === "file:") return;
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW:", err));
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("installBtn").hidden = false;
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  $("installBtn").hidden = true;
  toast("تم تثبيت التطبيق على جهازك");
});
$("installBtn").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $("installBtn").hidden = true;
});

/** نافذة «على الهاتف»: رمز QR وعنوان الموقع على شبكة الواي فاي */
async function openPhoneDialog() {
  let info;
  try {
    const res = await fetch(CONFIG.API_BASE + "/api/lan", { cache: "no-store" });
    info = await res.json();
  } catch (_) {
    toast("الخادم غير متصل", "error");
    return;
  }
  const usable = info.enabled && info.addresses.length;
  $("phoneDisabled").hidden = !!usable;
  $("phoneEnabled").hidden = !usable;
  if (!info.enabled) $("phoneDisabled").querySelector("p").innerHTML =
    'الوصول من الهاتف غير مفعّل. أضف السطر <code dir="ltr">HOST=0.0.0.0</code> إلى ملف <code dir="ltr">server/.env</code> ثم أعد تشغيل الخادم.';
  else if (!info.addresses.length) $("phoneDisabled").querySelector("p").textContent =
    "لم يُعثر على اتصال واي فاي أو شبكة محلية على هذا الحاسوب.";

  if (usable) {
    const select = $("lanSelect");
    select.innerHTML = "";
    info.addresses.forEach((a) => {
      const opt = document.createElement("option");
      opt.value = a.url;
      opt.textContent = `${a.url} (${a.interface})`;
      select.appendChild(opt);
    });
    select.hidden = info.addresses.length < 2;
    showLanUrl(info.addresses[0].url);
  }
  const dlg = $("phoneDialog");
  if (typeof dlg.showModal === "function") dlg.showModal();
}

function showLanUrl(url) {
  $("lanUrl").textContent = url;
  $("qrImg").src = CONFIG.API_BASE + "/api/qr.svg?url=" + encodeURIComponent(url);
}

$("phoneBtn").addEventListener("click", openPhoneDialog);
$("lanSelect").addEventListener("change", (e) => showLanUrl(e.target.value));
$("copyLanBtn").addEventListener("click", async () => {
  const ok = await copyText($("lanUrl").textContent);
  toast(ok ? "تم نسخ العنوان" : "تعذّر النسخ", ok ? "success" : "error");
});

/**
 * استقبال رابط مُشارَك من تطبيق آخر (YouTube أو Facebook…) بعد تثبيت التطبيق.
 * يصل الرابط في معاملات العنوان: ?url=… أو ?text=… (تطبيقات كثيرة تضعه داخل النص).
 */
async function handleSharedLink() {
  const p = new URLSearchParams(location.search);
  const shared = ["url", "text", "title"].map((k) => p.get(k) || "").join(" ");
  const match = shared.match(/https?:\/\/[^\s"'<>]+/);
  if (!p.toString()) return;
  history.replaceState(null, "", location.pathname); // إزالة المعاملات من شريط العنوان
  if (!match) {
    toast("لم يُعثر على رابط فيديو في ما تمت مشاركته", "error");
    return;
  }
  switchTab("url");
  els.videoUrl.value = match[0];
  els.videoUrl.dispatchEvent(new Event("input"));
  toast("تم استلام الرابط، جارٍ استخراج النص…", "info");
  await checkServer();
  startUrlExtraction();
}

// =========================================================
// التهيئة
// =========================================================
function init() {
  document.querySelectorAll("[data-site-name]").forEach((el) => (el.textContent = CONFIG.SITE_NAME));
  document.title = CONFIG.SITE_NAME + " — حوّل الفيديو إلى نص";
  try {
    const f = parseInt(localStorage.getItem("captionai.font"), 10);
    if (f >= CONFIG.FONT_MIN && f <= CONFIG.FONT_MAX) state.fontSize = f;
  } catch (_) { /* تجاهل */ }
  applyFont();
  if (navigator.share) els.deviceShareBtn.hidden = false;
  window.addEventListener("online", () => { toast("عاد الاتصال بالإنترنت", "info"); checkServer(); });
  window.addEventListener("offline", () => toast("انقطع الاتصال بالإنترنت", "error"));
  // زر «على الهاتف» يظهر عند فتح الموقع من الحاسوب نفسه فقط
  $("phoneBtn").hidden = !isLocalHost;
  registerServiceWorker();
  checkServer();
  handleSharedLink();
}
init();
