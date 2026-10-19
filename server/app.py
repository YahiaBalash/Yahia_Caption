# -*- coding: utf-8 -*-
"""
خادم «كابشن AI» — خادم Flask بسيط يقوم بثلاث مهام:
  1) جلب الترجمة/الكابشن الموجود مسبقاً للفيديو من رابطه (عبر yt-dlp، للمحتوى العام فقط).
  2) تفريغ الكلام المنطوق إلى نص (Speech-to-Text) عبر Groq أو OpenAI أو نموذج Whisper محلي.
  3) تقديم ملفات الواجهة (index.html و style.css و script.js) من نفس العنوان.

لماذا نحتاج خادماً؟
  - المتصفح لا يستطيع جلب ترجمات YouTube أو صوت الفيديو من موقع آخر بسبب سياسة CORS.
  - مفاتيح API السرية يجب ألا توضع في JavaScript الذي يعمل في المتصفح.
  - استخراج الصوت من الفيديو وضغطه يحتاج إلى ffmpeg.
"""

import os
import re
import json
import html
import time
import uuid
import hmac
import atexit
import shutil
import secrets
import socket
import logging
import tempfile
import threading
import subprocess
from urllib.parse import quote

import requests
import yt_dlp
from flask import Flask, request, jsonify, send_from_directory

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
except ImportError:
    pass

# ---------------------------------------------------------------------------
# الإعدادات (تُقرأ من ملف .env أو من متغيرات البيئة)
# ---------------------------------------------------------------------------
SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.dirname(SERVER_DIR)
# لا نقدّم أي ملف آخر من المجلد (حماية .env وملفات الخادم)
FRONTEND_FILES = {"index.html", "style.css", "script.js", "manifest.webmanifest", "sw.js",
                  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png",
                  "icons/apple-touch-icon.png", "icons/favicon-32.png", "asr-worker.js"}

STT_PROVIDER = os.getenv("STT_PROVIDER", "groq").strip().lower()  # groq | openai | local | none
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
GROQ_MODEL = os.getenv("GROQ_MODEL", "whisper-large-v3").strip()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "whisper-1").strip()
LOCAL_WHISPER_MODEL = os.getenv("LOCAL_WHISPER_MODEL", "small").strip()

MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "200"))
MAX_DURATION_MIN = int(os.getenv("MAX_DURATION_MIN", "90"))
API_FILE_LIMIT_MB = 25  # الحد الأقصى لحجم الملف الصوتي في واجهات Groq/OpenAI
PORT = int(os.getenv("PORT", "5000"))
# 127.0.0.1 = هذا الحاسوب فقط | 0.0.0.0 = يمكن فتح الموقع من الهاتف على نفس شبكة الواي فاي
HOST = os.getenv("HOST", "127.0.0.1").strip()

# نفق Cloudflare: لتعمل روابط الفيديو من صفحة GitHub عبر الإنترنت ما دام الحاسوب يعمل
TUNNEL = os.getenv("TUNNEL", "0").strip().lower() in ("1", "true", "yes")
PUBLIC_SITE_URL = os.getenv("PUBLIC_SITE_URL", "https://yahiabalash.github.io/Yahia_Caption/").strip()
_bundled = os.path.join(SERVER_DIR, "bin", "cloudflared.exe" if os.name == "nt" else "cloudflared")
CLOUDFLARED = _bundled if os.path.exists(_bundled) else shutil.which("cloudflared")
TUNNEL_URL = None
TUNNEL_ERROR = None


def load_access_key():
    """رمز دخول سري يُولَّد مرة واحدة ويُحفظ في server/.access_key (مستثنى من GitHub)."""
    path = os.path.join(SERVER_DIR, ".access_key")
    try:
        with open(path, encoding="utf-8") as f:
            key = f.read().strip()
            if len(key) >= 24:
                return key
    except OSError:
        pass
    key = secrets.token_urlsafe(24)
    with open(path, "w", encoding="utf-8") as f:
        f.write(key)
    return key


ACCESS_KEY = load_access_key()

ALLOWED_UPLOAD_EXT = {"mp4", "webm", "mov", "m4v", "mkv", "mp3", "m4a", "wav", "ogg"}
# الصيغ التي تقبلها واجهات Whisper مباشرة إن لم يتوفر ffmpeg
API_DIRECT_EXT = {"mp4", "webm", "mp3", "m4a", "wav", "ogg", "mpeg", "mpga", "flac"}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("caption-ai")

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024


class UserError(Exception):
    """خطأ برسالة عربية واضحة تُعرض للمستخدم كما هي."""

    def __init__(self, message, code="error"):
        super().__init__(message)
        self.message = message
        self.code = code


# ---------------------------------------------------------------------------
# أدوات مساعدة
# ---------------------------------------------------------------------------
def find_ffmpeg():
    """يبحث عن ffmpeg في النظام، أو يستخدم النسخة المضمّنة في حزمة imageio-ffmpeg."""
    path = shutil.which("ffmpeg")
    if path:
        return path
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


FFMPEG = find_ffmpeg()


def provider_status():
    """هل خدمة تفريغ الصوت جاهزة؟ يعيد (جاهز، رسالة)."""
    if STT_PROVIDER == "groq":
        return (bool(GROQ_API_KEY), "Groq Whisper" if GROQ_API_KEY else "لم يُضبط GROQ_API_KEY")
    if STT_PROVIDER == "openai":
        return (bool(OPENAI_API_KEY), "OpenAI Whisper" if OPENAI_API_KEY else "لم يُضبط OPENAI_API_KEY")
    if STT_PROVIDER == "local":
        try:
            import faster_whisper  # noqa: F401
            return (True, f"Whisper محلي ({LOCAL_WHISPER_MODEL})")
        except ImportError:
            return (False, "حزمة faster-whisper غير مثبّتة")
    return (False, "خدمة تفريغ الصوت معطّلة (STT_PROVIDER=none)")


def platform_name(extractor):
    names = {
        "youtube": "YouTube", "facebook": "Facebook", "instagram": "Instagram",
        "tiktok": "TikTok", "twitter": "X (Twitter)", "vimeo": "Vimeo",
        "dailymotion": "Dailymotion", "generic": "رابط مباشر",
    }
    key = (extractor or "").lower()
    for k, v in names.items():
        if key.startswith(k):
            return v
    return extractor or "غير معروف"


def build_text(segments):
    """يجمع المقاطع في فقرات مقروءة مع المحافظة على ترتيبها."""
    paragraphs, current, cur_len, prev_end = [], [], 0, None
    for seg in segments:
        t = seg["text"].strip()
        if not t:
            continue
        gap = (seg["start"] - prev_end) if prev_end is not None else 0
        ends_sentence = bool(current) and re.search(r"[.!?؟…»\"]$", current[-1])
        if current and ((gap >= 2.0 and cur_len >= 150) or (cur_len >= 550 and ends_sentence)):
            paragraphs.append(" ".join(current))
            current, cur_len = [], 0
        current.append(t)
        cur_len += len(t)
        prev_end = seg["end"]
    if current:
        paragraphs.append(" ".join(current))
    return "\n\n".join(paragraphs)


def merge_short_segments(segments, max_chars=90, max_gap=1.0):
    """الترجمات التلقائية تأتي كلمة بكلمة تقريباً؛ ندمجها في جمل أطول لملف SRT مقروء."""
    merged = []
    for seg in segments:
        if (merged and len(merged[-1]["text"]) < max_chars
                and seg["start"] - merged[-1]["end"] <= max_gap):
            merged[-1]["text"] += " " + seg["text"]
            merged[-1]["end"] = max(merged[-1]["end"], seg["end"])
        else:
            merged.append(dict(seg))
    return merged


def clean_caption_text(t):
    t = re.sub(r"<[^>]+>", "", t)          # إزالة وسوم التنسيق والتوقيت داخل VTT
    t = html.unescape(t)
    t = t.replace("​", "")
    # إزالة الوسوم الوصفية التي ليست كلاماً منطوقاً مثل [موسيقى] و[غناء] و[Music] وعلامة تغيير المتحدث >>
    t = re.sub(r"\[[^\]]{1,40}\]|\([^)]{0,20}(موسيقى|تصفيق|ضحك|Music|Applause|Laughter)[^)]{0,20}\)", " ", t)
    t = t.replace(">>", " ")
    return re.sub(r"\s+", " ", t).strip()


def parse_timestamp(s):
    s = s.strip().replace(",", ".")
    parts = s.split(":")
    sec = float(parts[-1])
    if len(parts) >= 2:
        sec += int(parts[-2]) * 60
    if len(parts) >= 3:
        sec += int(parts[-3]) * 3600
    return sec


def parse_vtt_or_srt(text):
    """يحلّل ملفات VTT و SRT، ويزيل الأسطر المكررة في ترجمات YouTube المتدحرجة."""
    segments, prev_lines = [], set()
    blocks = re.split(r"\n\s*\n", text.replace("\r", ""))
    for block in blocks:
        lines = [l for l in block.strip().split("\n") if l.strip()]
        idx = next((i for i, l in enumerate(lines) if "-->" in l), None)
        if idx is None:
            continue
        m = re.match(r"\s*([\d:.,]+)\s*-->\s*([\d:.,]+)", lines[idx])
        if not m:
            continue
        start, end = parse_timestamp(m.group(1)), parse_timestamp(m.group(2))
        cue_lines = [clean_caption_text(l) for l in lines[idx + 1:]]
        cue_lines = [l for l in cue_lines if l]
        new_lines = [l for l in cue_lines if l not in prev_lines]
        prev_lines = set(cue_lines)
        if not new_lines:
            if segments:
                segments[-1]["end"] = max(segments[-1]["end"], end)
            continue
        segments.append({"start": start, "end": end, "text": " ".join(new_lines)})
    return segments


def parse_json3(data):
    """يحلّل صيغة json3 الخاصة بترجمات YouTube."""
    segments = []
    for ev in data.get("events", []):
        if "segs" not in ev:
            continue
        t = clean_caption_text("".join(s.get("utf8", "") for s in ev["segs"]))
        if not t:
            continue
        start = ev.get("tStartMs", 0) / 1000.0
        end = start + ev.get("dDurationMs", 0) / 1000.0
        segments.append({"start": start, "end": end, "text": t})
    # منع تداخل التوقيتات
    for i in range(len(segments) - 1):
        if segments[i]["end"] > segments[i + 1]["start"]:
            segments[i]["end"] = segments[i + 1]["start"]
    return segments


def pick_track(tracks, lang_pref, orig_lang, automatic):
    """
    يختار مسار الترجمة الأنسب.
    - الترجمات التلقائية في YouTube متاحة مترجَمة آلياً لعشرات اللغات، لذلك لا نأخذ منها
      إلا لغة الفيديو الأصلية؛ لأن المطلوب تفريغ الكلام لا ترجمته.
    """
    if not tracks:
        return None
    keys = [k for k in tracks.keys() if k != "live_chat"]
    if not keys:
        return None

    def match(lang):
        return [k for k in keys if k == lang or k.startswith(lang + "-")]

    if automatic:
        if orig_lang:
            c = [k for k in keys if k == orig_lang + "-orig"] + match(orig_lang)
            if c and (not lang_pref or lang_pref == orig_lang):
                return c[0]
        orig = [k for k in keys if k.endswith("-orig")]
        if orig and (not lang_pref or orig[0].startswith(lang_pref)):
            return orig[0]
        return None

    if lang_pref and match(lang_pref):
        return match(lang_pref)[0]
    if orig_lang and match(orig_lang):
        return match(orig_lang)[0]
    if not lang_pref and not orig_lang and len(keys) == 1:
        return keys[0]
    return None


def explain_ytdlp_error(err):
    """يحوّل أخطاء yt-dlp إلى رسائل عربية مفهومة."""
    msg = str(err)
    low = msg.lower()
    if "unsupported url" in low:
        return UserError("هذا الرابط غير مدعوم. جرّب رابط فيديو مباشراً، أو نزّل الفيديو وارفعه من جهازك.", "unsupported")
    if "private video" in low or "video is private" in low:
        return UserError("هذا الفيديو خاص، ولا يمكن الوصول إليه دون صلاحية صاحبه.", "private")
    if any(x in low for x in ["sign in", "login", "log in", "--cookies", "registered users",
                              "age-restricted", "confirm your age", "inappropriate for some users"]):
        return UserError("المنصة تطلب تسجيل الدخول لمشاهدة هذا الفيديو (شائع في Facebook وInstagram). "
                         "لا نتجاوز قيود المنصات؛ إن كان لديك حق استخدام الفيديو فارفعه من جهازك.", "login_required")
    if any(x in low for x in ["unavailable", "removed", "404", "not found", "does not exist"]):
        return UserError("الفيديو غير متاح أو محذوف أو الرابط غير صحيح.", "unavailable")
    if any(x in low for x in ["geo", "country"]):
        return UserError("الفيديو غير متاح في منطقة الخادم الجغرافية.", "geo")
    if any(x in low for x in ["timed out", "connection", "network", "resolve", "getaddrinfo"]):
        return UserError("تعذّر الاتصال بالمنصة من الخادم. تأكد من اتصال الإنترنت ثم أعد المحاولة.", "network")
    if "403" in low or "forbidden" in low:
        return UserError("رفضت المنصة تنزيل الفيديو مؤقتاً (HTTP 403). انتظر دقيقة ثم اضغط «إعادة المحاولة». "
                         "إن تكرر ذلك فحدّث المكتبة: pip install -U yt-dlp", "forbidden")
    if "file is larger" in low or "max_filesize" in low:
        return UserError(f"الملف الصوتي أكبر من الحد المسموح ({MAX_UPLOAD_MB} ميغابايت).", "too_large")
    log.warning("yt-dlp error: %s", msg)
    return UserError("تعذّر جلب الفيديو من هذا الرابط. قد تكون المنصة تمنع الوصول الآلي إليه؛ "
                     "يمكنك رفع ملف الفيديو مباشرة بدلاً من ذلك.", "fetch_failed")


# ---------------------------------------------------------------------------
# معالجة الصوت وتحويل الكلام إلى نص
# ---------------------------------------------------------------------------
def media_duration(path):
    if not FFMPEG:
        return None
    try:
        p = subprocess.run([FFMPEG, "-hide_banner", "-i", path], capture_output=True, text=True,
                           encoding="utf-8", errors="ignore", timeout=60)
        m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", p.stderr)
        if m:
            return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    except Exception:
        pass
    return None


def prepare_audio(input_path, workdir):
    """
    يستخرج الصوت ويضغطه (أحادي، 16kHz، 32kbps) حتى يصغر حجمه كثيراً:
    ساعة كاملة ≈ 14 ميغابايت، أي ضمن حد 25 ميغابايت في واجهات Whisper.
    """
    if STT_PROVIDER == "local":
        return input_path  # faster-whisper يفك ترميز الملف بنفسه

    ext = input_path.rsplit(".", 1)[-1].lower()
    if not FFMPEG:
        size_mb = os.path.getsize(input_path) / 1024 / 1024
        if ext in API_DIRECT_EXT and size_mb <= API_FILE_LIMIT_MB:
            return input_path
        raise UserError("هذا الملف يحتاج إلى ffmpeg لاستخراج الصوت منه (لصيغة MOV/MKV أو للملفات الأكبر من "
                        f"{API_FILE_LIMIT_MB} ميغابايت). ثبّت الحزمة imageio-ffmpeg كما في README.", "ffmpeg_missing")

    out = os.path.join(workdir, "audio_16k.mp3")
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", input_path,
           "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", out]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore", timeout=1800)
    if p.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) < 1000:
        err = (p.stderr or "").lower()
        if "does not contain any stream" in err or "output file is empty" in err or "matches no streams" in err:
            raise UserError("الملف لا يحتوي على مسار صوتي، فلا يوجد كلام يمكن تفريغه.", "no_audio")
        log.warning("ffmpeg failed: %s", p.stderr)
        raise UserError("تعذّرت قراءة الملف. قد يكون تالفاً أو بصيغة غير مدعومة.", "bad_media")
    if os.path.getsize(out) / 1024 / 1024 > API_FILE_LIMIT_MB:
        raise UserError(f"المقطع طويل جداً لمعالجته دفعة واحدة. الحد التقريبي {MAX_DURATION_MIN} دقيقة.", "too_long")
    return out


def transcribe_api(audio_path, language):
    """يرسل الصوت إلى Groq أو OpenAI (كلاهما يستخدم نفس صيغة واجهة Whisper)."""
    if STT_PROVIDER == "groq":
        url, key, model = "https://api.groq.com/openai/v1/audio/transcriptions", GROQ_API_KEY, GROQ_MODEL
    else:
        url, key, model = "https://api.openai.com/v1/audio/transcriptions", OPENAI_API_KEY, OPENAI_MODEL

    data = {"model": model, "response_format": "verbose_json", "timestamp_granularities[]": "segment"}
    if language:
        data["language"] = language
    try:
        with open(audio_path, "rb") as f:
            r = requests.post(url, headers={"Authorization": f"Bearer {key}"}, data=data,
                              files={"file": (os.path.basename(audio_path), f)}, timeout=900)
    except requests.exceptions.RequestException:
        raise UserError("تعذّر الاتصال بخدمة تفريغ الصوت. تحقق من اتصال الخادم بالإنترنت.", "stt_network")

    if r.status_code == 401:
        raise UserError("مفتاح API لخدمة تفريغ الصوت غير صالح. راجع ملف server/.env", "stt_auth")
    if r.status_code == 403:
        raise UserError("خدمة التفريغ ترفض الاتصال من شبكتك أو بلدك (Access denied)، وليست المشكلة في المفتاح. "
                        "استخدم التفريغ المحلي: STT_PROVIDER=local في ملف server/.env", "stt_region_blocked")
    if r.status_code == 413:
        raise UserError("الملف الصوتي أكبر من الحد الذي تقبله خدمة التفريغ (25 ميغابايت).", "stt_too_large")
    if r.status_code == 429:
        raise UserError("تجاوزت حد الاستخدام المسموح لدى خدمة التفريغ. انتظر قليلاً ثم أعد المحاولة.", "stt_rate_limit")
    if r.status_code >= 400:
        log.warning("STT error %s: %s", r.status_code, r.text[:500])
        raise UserError(f"رفضت خدمة التفريغ الطلب (رمز {r.status_code}). راجع سجل الخادم للتفاصيل.", "stt_failed")

    j = r.json()
    segments = [{"start": float(s["start"]), "end": float(s["end"]), "text": s["text"].strip()}
                for s in (j.get("segments") or []) if s.get("text", "").strip()]
    return segments, j.get("text", "").strip(), j.get("language") or language


_local_model = None
_local_lock = threading.Lock()


def decode_audio_ffmpeg(path):
    """
    يفك ترميز الصوت عبر ffmpeg إلى مصفوفة (16kHz أحادي) ويمرّرها إلى faster-whisper مباشرة،
    فلا نعتمد على مكتبة PyAV التي قد لا يتوافق إصدارها مع faster-whisper.
    """
    if not FFMPEG:
        return path  # نترك faster-whisper يفك الترميز بنفسه
    import numpy as np
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-i", path,
           "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"]
    p = subprocess.run(cmd, capture_output=True, timeout=1800)
    if p.returncode != 0 or not p.stdout:
        err = p.stderr.decode("utf-8", errors="ignore").lower()
        if "does not contain any stream" in err or "matches no streams" in err or not p.stdout:
            raise UserError("الملف لا يحتوي على مسار صوتي، فلا يوجد كلام يمكن تفريغه.", "no_audio")
        log.warning("ffmpeg decode failed: %s", err)
        raise UserError("تعذّرت قراءة الملف. قد يكون تالفاً أو بصيغة غير مدعومة.", "bad_media")
    return np.frombuffer(p.stdout, dtype=np.float32).copy()


def transcribe_local(audio_path, language, on_progress):
    """تفريغ محلي مجاني عبر faster-whisper (أبطأ على المعالج، لا يحتاج إلى إنترنت بعد تنزيل النموذج)."""
    global _local_model
    from faster_whisper import WhisperModel
    try:
        with _local_lock:
            if _local_model is None:
                _local_model = WhisperModel(LOCAL_WHISPER_MODEL, device="auto", compute_type="int8")
        # لا نستخدم مرشّح كشف الصوت (VAD): كان يحذف الإنشاد والكلام فوق الموسيقى بالكامل.
        # condition_on_previous_text=False يمنع حلقات التكرار الوهمي في المقاطع الطويلة.
        seg_iter, info = _local_model.transcribe(decode_audio_ffmpeg(audio_path), language=language or None,
                                                 vad_filter=False, beam_size=5,
                                                 condition_on_previous_text=False)
        segments = []
        for s in seg_iter:
            if s.text.strip():
                segments.append({"start": s.start, "end": s.end, "text": s.text.strip()})
            if info.duration:
                on_progress(min(99, int(s.end / info.duration * 100)), segments)
    except (RuntimeError, MemoryError) as e:
        if "alloc" in str(e).lower() or isinstance(e, MemoryError):
            raise UserError("ذاكرة الجهاز غير كافية لتشغيل نموذج Whisper المحلي. أغلق بعض البرامج ثم أعد المحاولة، "
                            "أو استخدم نموذجاً أصغر (LOCAL_WHISPER_MODEL=base)، أو خدمة Groq المجانية (الأسرع).",
                            "out_of_memory")
        raise
    return segments, " ".join(s["text"] for s in segments), info.language


def local_progress(job_id, started):
    """يحدّث نسبة التقدّم والوقت المتبقي المتوقّع والنص المفرَّغ حتى الآن."""
    def update(p, segments):
        elapsed = time.time() - started
        eta = ""
        if p >= 3 and elapsed > 5:
            remaining = int(elapsed / p * (100 - p))
            eta = f" — متبقٍ نحو {remaining // 60} د {remaining % 60} ث" if remaining >= 60 else f" — متبقٍ نحو {remaining} ث"
        set_job(job_id, stage=f"جارٍ تفريغ الكلام على جهازك… {p}%{eta}", progress=p,
                partial=build_text(segments))
    return update


def transcribe(audio_path, language, job_id):
    ready, msg = provider_status()
    if not ready:
        raise UserError(f"خدمة تفريغ الكلام غير مُعدّة على الخادم: {msg}. راجع README.", "stt_not_configured")
    set_job(job_id, stage="جارٍ تفريغ الكلام إلى نص…", progress=None)
    if STT_PROVIDER == "local":
        set_job(job_id, stage="جارٍ تحميل نموذج Whisper في الذاكرة…")
        segments, text, lang = transcribe_local(audio_path, language, local_progress(job_id, time.time()))
    else:
        segments, text, lang = transcribe_api(audio_path, language)
    if not segments and not text:
        raise UserError("لم يُعثر على كلام منطوق واضح في هذا المقطع.", "no_speech")
    return segments, text, lang


# ---------------------------------------------------------------------------
# إدارة المهام (المعالجة تتم في الخلفية والواجهة تستعلم عن الحالة)
# ---------------------------------------------------------------------------
JOBS = {}
JOBS_LOCK = threading.Lock()


def new_job():
    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        now = time.time()
        for k in [k for k, v in JOBS.items() if now - v["created"] > 3600]:
            del JOBS[k]  # حذف المهام القديمة
        JOBS[job_id] = {"status": "running", "stage": "جارٍ البدء…", "progress": None,
                        "result": None, "error": None, "code": None, "partial": "", "created": now}
    return job_id


def set_job(job_id, **kw):
    with JOBS_LOCK:
        if job_id in JOBS:
            JOBS[job_id].update(kw)


def run_job(job_id, func, *args):
    workdir = tempfile.mkdtemp(prefix="caption_ai_")
    try:
        result = func(job_id, workdir, *args)
        set_job(job_id, status="done", stage="اكتمل", progress=100, result=result)
    except UserError as e:
        set_job(job_id, status="error", error=e.message, code=e.code)
    except Exception:
        log.exception("Unexpected error in job %s", job_id)
        set_job(job_id, status="error", code="internal",
                error="حدث خطأ غير متوقع في الخادم أثناء المعالجة. راجع سجل الخادم.")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def make_result(segments, text, language, source, meta=None, warnings=None):
    if segments:
        text = build_text(segments)
    return {
        "text": text,
        "segments": segments,
        "has_timestamps": bool(segments),
        "language": language,
        "source": source,
        "meta": meta or {},
        "warnings": warnings or [],
    }


# ---------------------------------------------------------------------------
# معالجة الروابط
# ---------------------------------------------------------------------------
def fetch_caption(ydl, info, lang_pref, orig_lang, automatic):
    tracks = info.get("automatic_captions" if automatic else "subtitles") or {}
    key = pick_track(tracks, lang_pref, orig_lang, automatic)
    if not key:
        return None
    formats = tracks[key]
    for wanted in ("json3", "vtt", "srt"):
        fmt = next((f for f in formats if f.get("ext") == wanted and f.get("url")), None)
        if not fmt:
            continue
        try:
            raw = ydl.urlopen(fmt["url"]).read().decode("utf-8", errors="ignore")
            segments = parse_json3(json.loads(raw)) if wanted == "json3" else parse_vtt_or_srt(raw)
        except Exception as e:
            log.warning("caption fetch failed (%s): %s", wanted, e)
            continue
        if automatic:
            segments = merge_short_segments(segments)
        if segments:
            return segments, key.replace("-orig", "")
    return None


def url_job(job_id, workdir, url, language, mode):
    base_opts = {"quiet": True, "no_warnings": True, "noplaylist": True, "socket_timeout": 30,
                 "retries": 5, "fragment_retries": 5, "extractor_retries": 3}
    if FFMPEG:
        base_opts["ffmpeg_location"] = FFMPEG

    set_job(job_id, stage="جارٍ جلب بيانات الفيديو…")
    try:
        with yt_dlp.YoutubeDL({**base_opts, "skip_download": True}) as ydl:
            info = ydl.extract_info(url, download=False)
            if info.get("_type") == "playlist" or info.get("entries"):
                raise UserError("هذا رابط قائمة تشغيل. أدخل رابط فيديو واحد.", "playlist")
            if info.get("is_live"):
                raise UserError("لا يمكن استخراج نص بث مباشر جارٍ. انتظر انتهاء البث ثم أعد المحاولة.", "live")

            meta = {
                "title": info.get("title") or "",
                "description": (info.get("description") or "")[:5000],
                "uploader": info.get("uploader") or info.get("channel") or "",
                "duration": info.get("duration"),
                "webpage_url": info.get("webpage_url") or url,
                "platform": platform_name(info.get("extractor_key") or info.get("extractor")),
            }
            orig_lang = (info.get("language") or "").split("-")[0] or None
            warnings = []

            # 1) الترجمة الرسمية التي رفعها صاحب الفيديو
            if mode in ("auto", "captions"):
                set_job(job_id, stage="جارٍ البحث عن ترجمة رسمية للفيديو…")
                got = fetch_caption(ydl, info, language, orig_lang, automatic=False)
                if got:
                    return make_result(got[0], "", got[1], "official_captions", meta)

            auto_caps = None
            if mode in ("auto", "captions"):
                set_job(job_id, stage="جارٍ البحث عن ترجمة تلقائية…")
                auto_caps = fetch_caption(ydl, info, language, orig_lang, automatic=True)
    except yt_dlp.utils.DownloadError as e:
        raise explain_ytdlp_error(e)

    stt_ready, stt_msg = provider_status()

    # 2) الترجمة التلقائية: في وضع «الترجمة الموجودة فقط»، أو في الوضع التلقائي عند غياب خدمة التفريغ
    #    أو عندما تكون الخدمة محلية (بطيئة على المعالج: قد تستغرق دقائق طويلة للمقطع الطويل).
    local_slow = STT_PROVIDER == "local"
    if mode == "captions" or (mode == "auto" and auto_caps and (not stt_ready or local_slow)):
        if auto_caps:
            if mode == "auto" and stt_ready:
                warnings.append("هذا النص من الترجمة التلقائية للمنصة لأنها فورية. إن وجدت فيه أخطاء، "
                                "اختر «تفريغ الصوت دائماً» لتفريغه بنموذج Whisper على جهازك (أبطأ).")
            elif mode == "auto":
                warnings.append("هذا النص من الترجمة التلقائية للمنصة وقد يحتوي على أخطاء وبلا علامات ترقيم؛ "
                                "اضبط خدمة تفريغ الصوت للحصول على دقة أعلى.")
            return make_result(auto_caps[0], "", auto_caps[1], "auto_captions", meta, warnings)
        raise UserError("لا توجد ترجمة منشورة لهذا الفيديو. اختر «تفريغ الصوت» من طريقة الاستخراج.", "no_captions")

    # 3) تفريغ الكلام المنطوق من صوت الفيديو
    if not stt_ready:
        raise UserError("لا توجد ترجمة لهذا الفيديو، وخدمة تفريغ الصوت غير مُعدّة على الخادم "
                        f"({stt_msg}). راجع README لإعدادها.", "stt_not_configured")
    duration = meta.get("duration")
    if duration and duration > MAX_DURATION_MIN * 60:
        raise UserError(f"مدة الفيديو أطول من الحد المسموح ({MAX_DURATION_MIN} دقيقة).", "too_long")

    def hook(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if total:
                p = int(d.get("downloaded_bytes", 0) / total * 100)
                set_job(job_id, stage=f"جارٍ تنزيل صوت الفيديو… {p}%", progress=p)

    set_job(job_id, stage="جارٍ تنزيل صوت الفيديو…", progress=0)
    try:
        dl_opts = {**base_opts, "format": "bestaudio/worst/best", "progress_hooks": [hook],
                   "outtmpl": os.path.join(workdir, "source.%(ext)s"),
                   "max_filesize": MAX_UPLOAD_MB * 1024 * 1024}
        # المنصات ترفض أحياناً التنزيل مؤقتاً (HTTP 403)؛ نعيد المحاولة مرتين قبل الاستسلام
        for attempt in range(3):
            try:
                with yt_dlp.YoutubeDL(dl_opts) as ydl:
                    ydl.extract_info(url, download=True)
                break
            except yt_dlp.utils.DownloadError as e:
                if "403" not in str(e) or attempt == 2:
                    raise
                log.info("HTTP 403 أثناء التنزيل، إعادة المحاولة %d", attempt + 1)
                set_job(job_id, stage="رفضت المنصة التنزيل مؤقتاً، نعيد المحاولة…", progress=None)
                time.sleep(3 * (attempt + 1))
    except yt_dlp.utils.DownloadError as e:
        if auto_caps:
            warnings.append("تعذّر تنزيل الصوت، فعُرضت الترجمة التلقائية للمنصة بدلاً منه.")
            return make_result(auto_caps[0], "", auto_caps[1], "auto_captions", meta, warnings)
        raise explain_ytdlp_error(e)

    files = [f for f in os.listdir(workdir) if f.startswith("source.") and not f.endswith(".part")]
    if not files:
        raise UserError("تعذّر تنزيل صوت الفيديو من المنصة.", "download_failed")

    set_job(job_id, stage="جارٍ تجهيز الصوت…", progress=None)
    try:
        audio = prepare_audio(os.path.join(workdir, files[0]), workdir)
        segments, text, lang = transcribe(audio, language, job_id)
    except UserError:
        if auto_caps:
            warnings.append("فشل تفريغ الصوت، فعُرضت الترجمة التلقائية للمنصة بدلاً منه.")
            return make_result(auto_caps[0], "", auto_caps[1], "auto_captions", meta, warnings)
        raise

    # فحص منطقي: إذا جاء التفريغ أقصر بكثير من الترجمة التلقائية (مثل الإنشاد فوق الموسيقى)
    # فالترجمة التلقائية أكمل، فنعرضها مع تنبيه بدلاً من نص ناقص.
    if auto_caps:
        stt_words = len((build_text(segments) if segments else text).split())
        cap_words = len(build_text(auto_caps[0]).split())
        if stt_words < cap_words * 0.5:
            warnings.append(f"تفريغ الصوت أعطى {stt_words} كلمة فقط مقابل {cap_words} في الترجمة التلقائية للمنصة "
                            "(يحدث مع الإنشاد أو الموسيقى المرتفعة)، فعُرضت الترجمة التلقائية لأنها أكمل.")
            return make_result(auto_caps[0], "", auto_caps[1], "auto_captions", meta, warnings)
    return make_result(segments, text, lang, "speech_to_text", meta, warnings)


def file_job(job_id, workdir, src_path, original_name, language):
    try:
        duration = media_duration(src_path)
        if duration and duration > MAX_DURATION_MIN * 60:
            raise UserError(f"مدة المقطع أطول من الحد المسموح ({MAX_DURATION_MIN} دقيقة).", "too_long")
        set_job(job_id, stage="جارٍ استخراج الصوت من الملف…")
        audio = prepare_audio(src_path, workdir)
        segments, text, lang = transcribe(audio, language, job_id)
        meta = {"title": original_name, "duration": duration, "platform": "ملف من جهازك"}
        return make_result(segments, text, lang, "speech_to_text", meta)
    finally:
        shutil.rmtree(os.path.dirname(src_path), ignore_errors=True)


# ---------------------------------------------------------------------------
# نقاط الاتصال (API)
# ---------------------------------------------------------------------------
@app.after_request
def add_cors(resp):
    # يسمح لصفحة GitHub وللملف المفتوح من الجهاز (file://) بالاتصال بهذا الخادم
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Access-Key"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Max-Age"] = "600"
    return resp


# ---------------------------------------------------------------------------
# الوصول من الإنترنت عبر نفق Cloudflare (لتعمل الروابط من صفحة GitHub)
# ---------------------------------------------------------------------------
def is_remote_request():
    """هل جاء الطلب من الإنترنت عبر النفق؟ (cloudflared يضيف هذه الترويسة دائماً)"""
    return bool(request.headers.get("Cf-Connecting-Ip")) or (request.host or "").endswith(".trycloudflare.com")


# ما يُسمح به عبر الإنترنت: الاستخراج فقط. الواجهة ومعلومات الشبكة ورموز QR للحاسوب وحده.
REMOTE_ALLOWED = re.compile(r"^/api/(health|transcribe/url|transcribe/file|jobs/[0-9a-f]{32})$")


@app.before_request
def guard_remote():
    if request.method == "OPTIONS":
        return "", 204
    if not is_remote_request():
        return None  # الحاسوب نفسه وشبكة البيت: كما كان سابقاً
    if not REMOTE_ALLOWED.match(request.path):
        return jsonify(error="غير موجود"), 404
    key = request.headers.get("X-Access-Key", "")
    if not (ACCESS_KEY and hmac.compare_digest(key.encode(), ACCESS_KEY.encode())):
        return jsonify(error="رمز الدخول غير صحيح. امسح رمز QR من نافذة «على الهاتف» في الحاسوب من جديد.",
                       code="bad_access_key"), 401
    return None


@app.errorhandler(413)
def too_large(_e):
    return jsonify(error=f"حجم الملف أكبر من الحد المسموح ({MAX_UPLOAD_MB} ميغابايت).", code="too_large"), 413


@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:name>")
def frontend_file(name):
    if name in FRONTEND_FILES:
        resp = send_from_directory(FRONTEND_DIR, name)
        if name == "sw.js":
            resp.headers["Cache-Control"] = "no-cache"  # حتى تصل تحديثات التطبيق إلى الهاتف فوراً
            resp.headers["Service-Worker-Allowed"] = "/"
        if name == "manifest.webmanifest":
            resp.headers["Content-Type"] = "application/manifest+json"
        return resp
    return jsonify(error="غير موجود"), 404


# ---------------------------------------------------------------------------
# الوصول من الهاتف عبر شبكة الواي فاي
# ---------------------------------------------------------------------------
VIRTUAL_IFACE = re.compile(r"vmware|vmnet|vethernet|virtual|hyper-v|vbox|docker|wsl|loopback|"
                           r"vpn|tun|tap|proton|wireguard|nord|zerotier|tailscale|bluetooth", re.I)


def lan_addresses():
    """يعيد عناوين الحاسوب على الشبكة المحلية، مع استبعاد محولات VPN والأجهزة الافتراضية."""
    found = []
    try:
        import psutil
        stats = psutil.net_if_stats()
        for name, addrs in psutil.net_if_addrs().items():
            if VIRTUAL_IFACE.search(name) or (name in stats and not stats[name].isup):
                continue
            for a in addrs:
                if a.family == socket.AF_INET and not a.address.startswith(("127.", "169.254.")):
                    # الواي فاي والإيثرنت أولاً
                    rank = 0 if re.search(r"wi-?fi|wlan|wireless|ethernet|eth|en\d", name, re.I) else 1
                    found.append((rank, a.address, name))
    except ImportError:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("10.255.255.255", 1))  # لا يُرسل أي بيانات؛ يحدد المحوّل الافتراضي فقط
            found.append((0, s.getsockname()[0], "default"))
            s.close()
        except OSError:
            pass
    found.sort()
    return [{"url": f"http://{ip}:{PORT}", "ip": ip, "interface": name} for _, ip, name in found]


@app.route("/api/lan")
def lan_info():
    return jsonify(enabled=HOST in ("0.0.0.0", "::"), port=PORT, addresses=lan_addresses())


def remote_link():
    """رابط صفحة GitHub مع عنوان النفق ورمز الدخول بعد علامة # (لا يُرسَل إلى خوادم GitHub)."""
    if not TUNNEL_URL:
        return None
    return f"{PUBLIC_SITE_URL}#server={quote(TUNNEL_URL, safe='')}&key={ACCESS_KEY}"


@app.route("/api/remote")
def remote_info():
    return jsonify(enabled=TUNNEL, available=bool(CLOUDFLARED), ready=bool(TUNNEL_URL),
                   error=TUNNEL_ERROR, tunnel_url=TUNNEL_URL, link=remote_link(), site=PUBLIC_SITE_URL)


@app.route("/api/qr.svg")
def qr_svg():
    """رمز QR لعنوان الموقع (نقبل فقط عناوين هذا الحاسوب ورابط الوصول من GitHub)."""
    url = request.args.get("url", "")
    if url not in {a["url"] for a in lan_addresses()} and url != remote_link():
        return jsonify(error="عنوان غير مسموح"), 400
    import io
    import qrcode
    import qrcode.image.svg
    img = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2)
    buf = io.BytesIO()
    img.save(buf)
    return buf.getvalue(), 200, {"Content-Type": "image/svg+xml", "Cache-Control": "no-store"}


@app.route("/api/health")
def health():
    ready, msg = provider_status()
    return jsonify(ok=True, stt_provider=STT_PROVIDER, stt_ready=ready, stt_message=msg,
                   ffmpeg=bool(FFMPEG), max_upload_mb=MAX_UPLOAD_MB,
                   max_duration_min=MAX_DURATION_MIN, allowed_ext=sorted(ALLOWED_UPLOAD_EXT))


LANG_RE = re.compile(r"^[a-z]{2,3}$")


@app.route("/api/transcribe/url", methods=["POST", "OPTIONS"])
def transcribe_url():
    if request.method == "OPTIONS":
        return "", 204
    body = request.get_json(silent=True) or {}
    url = (body.get("url") or "").strip()
    language = (body.get("language") or "").strip().lower()
    mode = body.get("mode") or "auto"
    if not re.match(r"^https?://[^\s/$.?#].[^\s]*$", url, re.I):
        return jsonify(error="الرابط غير صحيح. يجب أن يبدأ بـ http:// أو https://", code="invalid_url"), 400
    if language and not LANG_RE.match(language):
        return jsonify(error="رمز اللغة غير صالح.", code="invalid_lang"), 400
    if mode not in ("auto", "captions", "speech"):
        mode = "auto"
    job_id = new_job()
    threading.Thread(target=run_job, args=(job_id, url_job, url, language, mode), daemon=True).start()
    return jsonify(job_id=job_id), 202


@app.route("/api/transcribe/file", methods=["POST", "OPTIONS"])
def transcribe_file():
    if request.method == "OPTIONS":
        return "", 204
    f = request.files.get("file")
    language = (request.form.get("language") or "").strip().lower()
    if not f or not f.filename:
        return jsonify(error="لم يُرسل أي ملف.", code="no_file"), 400
    ext = f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
    if ext not in ALLOWED_UPLOAD_EXT:
        return jsonify(error="صيغة الملف غير مدعومة. الصيغ المسموحة: " + "، ".join(sorted(ALLOWED_UPLOAD_EXT)),
                       code="unsupported_file"), 400
    if language and not LANG_RE.match(language):
        return jsonify(error="رمز اللغة غير صالح.", code="invalid_lang"), 400
    upload_dir = tempfile.mkdtemp(prefix="caption_up_")
    path = os.path.join(upload_dir, "upload." + ext)
    f.save(path)
    job_id = new_job()
    threading.Thread(target=run_job, args=(job_id, file_job, path, f.filename, language), daemon=True).start()
    return jsonify(job_id=job_id), 202


@app.route("/api/jobs/<job_id>")
def job_status(job_id):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return jsonify(error="المهمة غير موجودة أو انتهت صلاحيتها.", code="job_not_found"), 404
        return jsonify({k: v for k, v in job.items() if k != "created"})


def start_tunnel():
    """يشغّل نفق Cloudflare السريع (مجاني، دون حساب) ويلتقط عنوانه المؤقت."""
    global TUNNEL_URL, TUNNEL_ERROR
    if not CLOUDFLARED:
        TUNNEL_ERROR = "برنامج cloudflared غير موجود في server/bin (راجع README)."
        log.warning(TUNNEL_ERROR)
        return
    proc = subprocess.Popen([CLOUDFLARED, "tunnel", "--url", f"http://127.0.0.1:{PORT}", "--no-autoupdate"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
                            encoding="utf-8", errors="ignore",
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    atexit.register(proc.terminate)  # إغلاق النفق مع إغلاق الخادم

    def read_output():
        global TUNNEL_URL, TUNNEL_ERROR
        for line in proc.stderr:
            m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
            if m and not TUNNEL_URL:
                TUNNEL_URL = m.group(0)
                log.info("النفق جاهز. من الهاتف عبر GitHub افتح (أو امسح رمز QR من زر «على الهاتف»):")
                log.info("%s", remote_link())
        if not TUNNEL_URL:
            TUNNEL_ERROR = "تعذّر فتح النفق. تحقق من اتصال الإنترنت ثم أعد تشغيل الخادم."
            log.warning(TUNNEL_ERROR)

    threading.Thread(target=read_output, daemon=True).start()


if __name__ == "__main__":
    ready, msg = provider_status()
    log.info("خدمة التفريغ: %s | جاهزة: %s | ffmpeg: %s", msg, ready, FFMPEG or "غير متوفر")
    log.info("افتح المتصفح على: http://localhost:%d", PORT)
    if HOST in ("0.0.0.0", "::"):
        for a in lan_addresses():
            log.info("من الهاتف (نفس شبكة الواي فاي): %s  [%s]", a["url"], a["interface"])
    if TUNNEL:
        start_tunnel()
    app.run(host=HOST, port=PORT, debug=False, threaded=True)
