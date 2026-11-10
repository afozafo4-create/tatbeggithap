/**
 * POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات (ثنائي ≤4MB)
 * Content-Type: application/octet-stream — يُخزَّن في source_chunks ويحدَّث received
 */
const store = require("../lib/db");
const { limits, readBody, sendJson, sendError } = require("../lib/util");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendError(res, 405, "الطريقة غير مسموحة — استخدم POST");

  const jobId = req.query.job;
  const seq = Number(req.query.seq);
  const chunk = Number(req.query.chunk);
  if (!jobId || Number.isNaN(seq) || Number.isNaN(chunk) || chunk < 0) {
    return sendError(res, 400, "معطيات الرفع ناقصة — استخدم ?job=<id>&seq=<n>&chunk=<k>");
  }

  const job = await store.getJob(jobId);
  if (!job) return sendError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
  if (!["queued", "uploading"].includes(job.status)) {
    return sendError(res, 409, `المهمة في حالة ${job.status} — لا يمكن الرفع الآن`);
  }

  const sources = await store.listSources(jobId);
  const src = sources.find((s) => Number(s.seq) === seq);
  if (!src) return sendError(res, 404, `المصدر رقم ${seq} غير موجود في هذه المهمة`);
  if (src.kind !== "file") return sendError(res, 400, "المصدر رابط وليس ملفًا — لا حاجة للرفع");

  const lim = limits();
  let body;
  try {
    body = await readBody(req, lim.uploadChunkBytes);
  } catch (e) {
    return sendError(res, e.status || 413, e.message);
  }
  if (!body.length) return sendError(res, 400, "الجزء فارغ");

  await store.putSourceChunk(jobId, seq, chunk, body);
  const received = await store.blobSize("source", jobId, seq);
  await store.updateSourceReceived(jobId, seq, received);

  // الحد: حجم كل مصدر أثناء الرفع
  if (src.size && received > Number(src.size) + 4096) {
    return sendError(res, 413, `الحجم المرفوع يتجاوز حجم الملف المعلن (${src.size} بايت)`);
  }
  if (received > lim.sourceMaxMB * 1024 * 1024) {
    return sendError(res, 413, `حجم الملف يتجاوز الحد المسموح (${lim.sourceMaxMB}MB)`);
  }

  const complete = src.size ? received >= Number(src.size) : false;
  if (complete && job.status === "uploading") {
    // هل اكتملت كل الملفات؟
    const all = await store.listSources(jobId);
    let allDone = true;
    for (const s of all) {
      if (s.kind === "file") {
        const sz = await store.blobSize("source", jobId, s.seq);
        if (sz < Number(s.size || 1)) {
          allDone = false;
          break;
        }
      }
    }
    if (allDone) await store.updateJob(jobId, { status: "queued" });
  }

  return sendJson(res, 200, { ok: true, seq, chunk, received, size: src.size, complete });
};
