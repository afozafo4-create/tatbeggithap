/**
 * محرك الدمج — جودة عالية إلزامية
 * ffprobe لكل مصدر: الدقة، معدل الإطارات، المدة، وجود صوت
 * توحيد كل المصادر عبر filter_complex: scale + pad إلى أكبر دقة بين المدخلات
 * (حد أقصى 1920×1080، أبعاد زوجية)، fps=30، setsar=1، format=yuv420p، ثم concat=n=:v=1:a=1
 * مصدر بلا صوت؟ مسار صامت anullsrc بنفس مدته بدل أن يفشل الدمج
 * الترميز النهائي: libx264 CRF 18 + AAC 192k/44100Hz + +faststart — MP4
 * التقدم: قراءة out_time_us من -progress pipe:1 (0-40 سحب، 40-90 ترميز، 100 اكتمال)
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

/* --------------------- إيجاد ثنائيات ffmpeg/ffprobe --------------------- */

function resolveStatic(modName, exeName, envKey) {
  if (process.env[envKey] && fs.existsSync(process.env[envKey])) {
    return process.env[envKey];
  }
  try {
    const mod = require(modName);
    const p = typeof mod === "string" ? mod : mod.path || mod;
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* الحزمة الاختيارية غير مثبتة — نعتمد النظام */
  }
  return exeName; // من PATH
}

function ffmpegPath() {
  return resolveStatic("ffmpeg-static", "ffmpeg", "FFMPEG_PATH");
}

function ffprobePath() {
  return resolveStatic("ffprobe-static", "ffprobe", "FFPROBE_PATH");
}

/** الثنائي قد يفقد صلاحية التنفيذ في الاستضافة: انسخه إلى /tmp بصلاحية 755 عند الحاجة */
function ensureExecutable(bin) {
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return bin;
  } catch {
    if (!fs.existsSync(bin) || fs.statSync(bin).isDirectory()) return bin; // من PATH
    const tmp = path.join(os.tmpdir(), `merger-bin-${path.basename(bin)}`);
    fs.copyFileSync(bin, tmp);
    fs.chmodSync(tmp, 0o755);
    return tmp;
  }
}

function run(bin, args, onStdout) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ensureExecutable(bin), args);
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => {
      out += d.toString();
      if (onStdout) onStdout(d.toString());
    });
    proc.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 100000) err = err.slice(-50000); // منع تضخم الذاكرة
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${path.basename(bin)} خرج بكود ${code}: ${err.slice(-800)}`));
    });
  });
}

/* ------------------------------- ffprobe ------------------------------- */

/** استخراج: الدقة، معدل الإطارات، المدة، وجود صوت */
async function probe(binPath, filePath) {
  const { out } = await run(ffprobePath(), [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  const info = JSON.parse(out);
  const v = info.streams?.find((s) => s.codec_type === "video");
  const a = info.streams?.find((s) => s.codec_type === "audio");
  if (!v) throw new Error("المصدر بلا مسار فيديو صالح");
  const fpsParts = String(v.avg_frame_rate || v.r_frame_rate || "30/1").split("/");
  const fps = Number(fpsParts[0]) / (Number(fpsParts[1]) || 1);
  return {
    width: v.width,
    height: v.height,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
    duration: Number(info.format?.duration || v.duration || 0),
    hasAudio: Boolean(a),
  };
}

/* --------------------------- تنزيل المصادر بالرابط --------------------------- */

/** تنزيل تدفقي مع عدّاد بايتات للتحقق من الحد أثناء التنزيل */
async function downloadUrl(url, destPath, maxBytes, onProgress) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > maxBytes) {
    throw new Error(`حجم المصدر يتجاوز الحد المسموح (${Math.round(maxBytes / 1024 / 1024)}MB)`);
  }
  const file = fs.createWriteStream(destPath);
  let received = 0;
  const reader = res.body.getReader();
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          if (received > maxBytes) {
            reader.cancel();
            file.destroy();
            reject(new Error(`حجم المصدر يتجاوز الحد المسموح (${Math.round(maxBytes / 1024 / 1024)}MB)`));
            return;
          }
          if (!file.write(Buffer.from(value))) {
            await new Promise((r) => file.once("drain", r));
          }
          if (onProgress && len) onProgress(received / len);
        }
        file.end(() => resolve({ received }));
      } catch (e) {
        file.destroy();
        reject(e);
      }
    })();
  });
}

/* ------------------------------ الدمج الكامل ------------------------------ */

/** أبعاد الهدف: أكبر دقة بين المدخلات بحد 1920×1080 وأبعاد زوجية */
function targetResolution(probes) {
  let w = 0;
  let h = 0;
  for (const p of probes) {
    if (p.width * p.height > w * h) {
      w = p.width;
      h = p.height;
    }
  }
  if (w > 1920 || h > 1080) {
    const scale = Math.min(1920 / w, 1080 / h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  w = Math.max(2, w - (w % 2));
  h = Math.max(2, h - (h % 2));
  return { width: w, height: h };
}

/**
 * دمج المصادر المحلية في ملف واحد:
 * - filter_complex موحّد (scale + pad + fps + setsar + yuv420p) ثم concat
 * - المصادر بلا صوت تحصل على مسار anullsrc صامت بمدة المصدر
 * - onProgress(ratio01) للتقدم الكلي
 */
async function mergeVideos(binPath, items, outPath, preset, onProgress) {
  // items: [{ path, probe }]
  const totalDuration = items.reduce((s, i) => s + i.probe.duration, 0);
  const { width: W, height: H } = targetResolution(items.map((i) => i.probe));

  const args = ["-y", "-nostdin"];
  // المدخلات: كل مصدر + مدخلات صامتة للمصادر بلا صوت
  const filters = [];
  const concatPairs = [];
  let silentIdx = items.length;
  items.forEach((item, i) => {
    args.push("-i", item.path);
    filters.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`
    );
    if (item.probe.hasAudio) {
      filters.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    } else {
      // مسار صامت بنفس مدة المصدر بدل أن يفشل الدمج
      args.push("-f", "lavfi", "-t", String(Math.max(0.1, item.probe.duration)), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
      filters.push(`[${silentIdx}:a]aresample=44100[a${i}]`);
      silentIdx++;
    }
    concatPairs.push(`[v${i}][a${i}]`);
  });
  filters.push(`${concatPairs.join("")}concat=n=${items.length}:v=1:a=1[v][a]`);
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-crf", "18", "-preset", preset || process.env.FFMPEG_PRESET || "medium",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
    "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats",
    outPath
  );

  await run(ffmpegPath(), args, (stdoutChunk) => {
    // قراءة out_time_us من -progress pipe:1 وحساب النسبة من المدة الإجمالية
    for (const line of stdoutChunk.split("\n")) {
      const m = line.match(/^out_time_us=(\d+)/);
      if (m && totalDuration > 0 && onProgress) {
        const seconds = Number(m[1]) / 1_000_000;
        onProgress(Math.max(0, Math.min(1, seconds / totalDuration)));
      }
    }
  });

  return { width: W, height: H };
}

module.exports = { ffmpegPath, ffprobePath, ensureExecutable, probe, downloadUrl, mergeVideos, targetResolution };
