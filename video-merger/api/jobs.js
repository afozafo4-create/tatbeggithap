/**
 * POST /api/jobs — إنشاء مهمة دمج
 * يقبل {"videos":["رابط1","رابط2"]} أو {"sources":[{"kind":"url","url":...},{"kind":"file","name":...,"size":...,"mime":...}]}
 * يرجع 201: {"jobId","status","statusUrl","processUrl","expiresAt"} — وإن وُجدت ملفات يرجع uploads[] برابط رفع لكل مصدر + uploadChunkBytes
 */
const store = require("../lib/db");
const { limits, readJson, baseUrl, sendJson, sendError, newJobId } = require("../lib/util");

const ALLOWED_EXT = ["mp4", "mov", "webm", "mkv", "avi", "m4v", "mpg", "3gp"];

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendError(res, 405, "الطريقة غير مسموحة — استخدم POST");
  }

  // تنظيف كسول للمهام المنتهية (24 ساعة)
  await store.deleteExpiredJobs().catch(() => {});

  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendError(res, e.status || 400, e.message);
  }

  const lim = limits();

  // توحيد المصادر من الحقلين
  let sources = [];
  if (Array.isArray(body.videos)) {
    sources = body.videos.map((u) => ({ kind: "url", url: String(u || "").trim() }));
  } else if (Array.isArray(body.sources)) {
    sources = body.sources.map((s) => ({
      kind: s.kind === "file" ? "file" : "url",
      url: s.url ? String(s.url).trim() : undefined,
      name: s.name ? String(s.name) : undefined,
      size: s.size ? Number(s.size) : 0,
      mime: s.mime ? String(s.mime) : undefined,
    }));
  }
  sources = sources.filter((s) => (s.kind === "url" && s.url) || (s.kind === "file" && s.name));

  if (sources.length < 2) {
    return sendError(res, 400, "الدمج يحتاج مقطعَين على الأقل — أرسل روابط أو ملفات صالحة");
  }
  if (sources.length > lim.maxSources) {
    return sendError(res, 400, `أقصى عدد مقاطع للدمج هو ${lim.maxSources}`);
  }
  for (const s of sources) {
    if (s.kind === "url" && !/^https?:\/\/.+/i.test(s.url)) {
      return sendError(res, 400, `الرابط غير صالح: ${s.url}`);
    }
    if (s.kind === "url" && /localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\./i.test(s.url)) {
      return sendError(res, 400, "الروابط الداخلية غير مسموحة — أرسل روابط عامة مباشرة فقط");
    }
    if (s.kind === "file") {
      const ext = (s.name.split(".").pop() || "").toLowerCase();
      if (!ALLOWED_EXT.includes(ext)) {
        return sendError(res, 400, `امتداد الملف غير مدعوم (${s.name}) — المسموح: ${ALLOWED_EXT.join(" / ")}`);
      }
      if (s.size > lim.sourceMaxMB * 1024 * 1024) {
        return sendError(res, 413, `حجم الملف ${s.name} يتجاوز الحد (${lim.sourceMaxMB}MB)`);
      }
    }
  }
  const totalSize = sources.reduce((acc, s) => acc + (s.size || 0), 0);
  if (totalSize > lim.sourceMaxMB * 1024 * 1024) {
    return sendError(res, 413, `إجمالي أحجام الملفات يتجاوز الحد (${lim.sourceMaxMB}MB)`);
  }

  const jobId = newJobId();
  const hasFiles = sources.some((s) => s.kind === "file");
  await store.insertJob(jobId, hasFiles ? "uploading" : "queued");
  for (let i = 0; i < sources.length; i++) {
    await store.insertSource(jobId, i, sources[i]);
  }

  const base = baseUrl(req);
  const job = await store.getJob(jobId);
  const response = {
    jobId,
    status: job.status,
    statusUrl: `${base}/api/jobs/${jobId}`,
    processUrl: `${base}/api/jobs/${jobId}/process`,
    expiresAt: job.expires_at,
  };
  if (hasFiles) {
    response.uploads = sources.map((s, i) =>
      s.kind === "file"
        ? {
            seq: i,
            name: s.name,
            size: s.size,
            uploadUrl: `${base}/api/upload?job=${jobId}&seq=${i}&chunk=<CHUNK_INDEX>`,
            uploadChunkBytes: lim.uploadChunkBytes,
          }
        : { seq: i, url: s.url }
    );
  }
  return sendJson(res, 201, response);
};
