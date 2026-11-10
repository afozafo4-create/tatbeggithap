/**
 * POST /api/jobs/<id>/process — تنفيذ الدمج كاملًا (متزامن):
 * ينزّل/يسحب المصادر ← يرمّز ← يحفظ، ويرجع مباشرة:
 * {"status":"done","videoUrl","downloadUrl","size","duration","resolution","expiresAt"}
 * لو المهمة قيد المعالجة فعله يرجع 202.
 * القواعد: فشل أي مصدر (رفض تنزيل/حدود) = فشل واضح برسالة وليس انهيار.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const store = require("../../../lib/db");
const { blobToStream } = require("../../../lib/storage");
const { probe, downloadUrl, mergeVideos, ffmpegPath } = require("../../../lib/merge");
const { limits, baseUrl, sendJson, sendError } = require("../../../lib/util");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendError(res, 405, "الطريقة غير مسموحة — استخدم POST");
  const jobId = req.query.id;
  if (!jobId) return sendError(res, 400, "معرّف المهمة مفقود");

  const job = await store.getJob(jobId);
  if (!job) return sendError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");

  if (job.status === "processing") return sendJson(res, 202, { status: "processing", progress: job.progress });
  if (job.status === "done") {
    // مكتملة سابقًا — أعِد النتيجة مباشرة
    const base = baseUrl(req);
    return sendJson(res, 200, {
      status: "done",
      videoUrl: `${base}/api/jobs/${jobId}/video`,
      downloadUrl: `${base}/api/jobs/${jobId}/video?download=1`,
      size: job.output_size,
      duration: job.output_duration,
      resolution: job.output_resolution,
      expiresAt: job.expires_at,
    });
  }

  const lim = limits();
  const sources = await store.listSources(jobId);
  if (sources.length < 2) return sendError(res, 409, "المهمة بلا مصادر كافية (مقطعان على الأقل مطلوبان)");

  // تحقق اكتمال الملفات المرفوعة قبل البدء
  for (const s of sources) {
    if (s.kind === "file") {
      const stored = await store.blobSize("source", jobId, s.seq);
      if (stored === 0) return sendError(res, 409, `الملف «${s.name}» لم يُرفع بعد — ارفع الأجزاء أولًا`);
      if (s.size && stored !== Number(s.size)) {
        return sendError(res, 409, `الملف «${s.name}» غير مكتمل (${stored} من ${s.size} بايت)`);
      }
    }
  }

  await store.updateJob(jobId, { status: "processing", progress: 0, error: null });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-"));
  const localPaths = [];
  try {
    /* ------------------------- المرحلة 1: سحب المصادر (0-40%) ------------------------- */
    const maxBytes = lim.sourceMaxMB * 1024 * 1024;
    let done = 0;
    for (const s of sources) {
      const dest = path.join(tmpDir, `src-${s.seq}.bin`);
      if (s.kind === "url") {
        await downloadUrl(s.url, dest, maxBytes, (r) => {
          const pct = ((Number(s.seq) + r) / sources.length) * 40;
          store.updateJob(jobId, { progress: Math.round(pct) }).catch(() => {});
        });
      } else {
        // سحب الملف المرفوع من قاعدة البيانات إلى /tmp أثناء المعالجة فقط
        await new Promise((resolve, reject) => {
          const stream = blobToStream("source", jobId, s.seq, 0, Number.MAX_SAFE_INTEGER);
          const file = fs.createWriteStream(dest);
          stream.on("error", reject);
          file.on("error", reject);
          file.on("finish", resolve);
          stream.pipe(file);
        });
      }
      localPaths.push({ seq: Number(s.seq), path: dest });
      done++;
      await store.updateJob(jobId, { progress: Math.round((done / sources.length) * 40) }).catch(() => {});
    }

    /* --------------------- المرحلة 2: فحص الحدود قبل الترميز --------------------- */
    const probes = [];
    let totalDuration = 0;
    for (const lp of localPaths) {
      const p = await probe(ffmpegPath(), lp.path);
      if (!p.duration || p.duration <= 0) {
        throw new Error(`تعذر قياس مدة المصدر رقم ${lp.seq + 1} — ملف تالف أو غير مدعوم`);
      }
      totalDuration += p.duration;
      probes.push({ ...lp, probe: p });
    }
    if (totalDuration > lim.maxTotalDurationSec) {
      throw new Error(`مجموع مدد المقاطع ${Math.round(totalDuration)} ثانية يتجاوز الحد (${lim.maxTotalDurationSec} ثانية)`);
    }

    /* ------------------------- المرحلة 3: الترميز (40-90%) ------------------------- */
    const outPath = path.join(tmpDir, "out.mp4");
    const { width, height } = await mergeVideos(
      ffmpegPath(),
      probes.map((p) => ({ path: p.path, probe: p.probe })),
      outPath,
      lim.ffmpegPreset,
      (r) => {
        const pct = 40 + r * 50; // 0-40 سحب، 40-90 ترميز
        store.updateJob(jobId, { progress: Math.round(pct) }).catch(() => {});
      }
    );

    /* --------------------- المرحلة 4: التحقق والتخزين (90-100%) --------------------- */
    const outSize = fs.statSync(outPath).size;
    if (outSize === 0) throw new Error("الناتج فارغ — فشل الترميز");
    if (outSize > lim.outputMaxMB * 1024 * 1024) {
      throw new Error(`حجم الناتج ${Math.round(outSize / 1024 / 1024)}MB يتجاوز الحد (${lim.outputMaxMB}MB)`);
    }

    const buffer = fs.readFileSync(outPath);
    await store.saveOutput(jobId, buffer);
    await store.deleteSourceChunks(jobId); // بعد نجاح الدمج احذف source_chunks — الناتج فقط هو المطلوب

    const total = totalDuration;
    await store.updateJob(jobId, {
      status: "done",
      progress: 100,
      output_size: outSize,
      output_duration: Math.round(total * 100) / 100,
      output_resolution: `${width}x${height}`,
    });

    const base = baseUrl(req);
    const fresh = await store.getJob(jobId);
    return sendJson(res, 200, {
      status: "done",
      videoUrl: `${base}/api/jobs/${jobId}/video`,
      downloadUrl: `${base}/api/jobs/${jobId}/video?download=1`,
      size: outSize,
      duration: Math.round(total * 100) / 100,
      resolution: `${width}x${height}`,
      expiresAt: fresh.expires_at,
    });
  } catch (e) {
    const message = e?.message || "فشل الدمج لسبب غير معروف";
    await store.updateJob(jobId, { status: "failed", progress: 0, error: message.slice(0, 500) }).catch(() => {});
    return sendError(res, 500, message);
  } finally {
    // لا نظام ملفات دائم — نظّف /tmp دائمًا
    for (const f of fs.readdirSync(tmpDir)) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch { /* تجاهل */ }
    }
    try { fs.rmdirSync(tmpDir); } catch { /* تجاهل */ }
  }
};
