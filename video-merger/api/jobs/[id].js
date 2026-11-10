/**
 * GET    /api/jobs/<id> — الحالة + التقدم (0–100) + الرابط عند الاكتمال
 * DELETE /api/jobs/<id> — حذف فوري شامل (jobs + sources + source_chunks + output_chunks)
 */
const store = require("../../lib/db");
const { baseUrl, sendJson, sendError } = require("../../lib/util");

module.exports = async function handler(req, res) {
  const jobId = req.query.id;
  if (!jobId) return sendError(res, 400, "معرّف المهمة مفقود");

  if (req.method === "GET") {
    const job = await store.getJob(jobId);
    if (!job) return sendError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");

    const base = baseUrl(req);
    const out = {
      jobId,
      status: job.status,
      progress: Number(job.progress || 0),
      expiresAt: job.expires_at,
    };
    if (job.status === "done") {
      out.videoUrl = `${base}/api/jobs/${jobId}/video`;
      out.downloadUrl = `${base}/api/jobs/${jobId}/video?download=1`;
      out.size = job.output_size;
      out.duration = job.output_duration;
      out.resolution = job.output_resolution;
    }
    if (job.status === "failed") out.error = job.error || "فشل غير معروف";
    return sendJson(res, 200, out);
  }

  if (req.method === "DELETE") {
    const job = await store.getJob(jobId);
    if (!job) return sendError(res, 404, "المهمة غير موجودة");
    await store.deleteJob(jobId);
    return sendJson(res, 200, { ok: true, deleted: jobId });
  }

  return sendError(res, 405, "الطريقة غير مسموحة — استخدم GET أو DELETE");
};
