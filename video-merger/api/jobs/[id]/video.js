/**
 * GET /api/jobs/<id>/video — بث الناتج بدعم Range (206 + Content-Range)
 * ليعمل التقديم/الترجيع في المشغل، و?download=1 للتحميل المباشر
 */
const store = require("../../../lib/db");
const { blobToStream } = require("../../../lib/storage");
const { sendError } = require("../../../lib/util");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return sendError(res, 405, "الطريقة غير مسموحة — استخدم GET");
  const jobId = req.query.id;
  if (!jobId) return sendError(res, 400, "معرّف المهمة مفقود");

  const job = await store.getJob(jobId);
  if (!job) return sendError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
  if (job.status !== "done") {
    return sendError(res, 409, `الناتج غير جاهز بعد — الحالة الحالية: ${job.status}`);
  }

  const totalSize = await store.blobSize("output", jobId);
  if (totalSize === 0) return sendError(res, 404, "الناتج غير موجود في التخزين");

  const isDownload = req.query.download === "1" || req.query.download === "true";
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Accept-Ranges": "bytes",
    "Content-Type": "video/mp4",
    "Cache-Control": "no-store",
  };
  if (isDownload) {
    headers["Content-Disposition"] = `attachment; filename="merged-${jobId}.mp4"`;
  }

  // تحليل المدى: bytes=start-end
  const rangeHeader = req.headers["range"];
  let start = 0;
  let end = totalSize - 1;
  if (rangeHeader) {
    const m = String(rangeHeader).match(/bytes=(\d*)-(\d*)/);
    if (m) {
      if (m[1] !== "") {
        start = Number(m[1]);
        end = m[2] !== "" ? Math.min(Number(m[2]), totalSize - 1) : totalSize - 1;
      } else if (m[2] !== "") {
        // لاحقة: آخر N بايت
        const n = Number(m[2]);
        start = Math.max(0, totalSize - n);
        end = totalSize - 1;
      }
    }
    if (start >= totalSize || start > end) {
      res.writeHead(416, {
        "Content-Range": `bytes */${totalSize}`,
        "Access-Control-Allow-Origin": "*",
      });
      return res.end();
    }
    headers["Content-Range"] = `bytes ${start}-${end}/${totalSize}`;
    headers["Content-Length"] = end - start + 1;
    res.writeHead(206, headers);
  } else {
    headers["Content-Length"] = totalSize;
    res.writeHead(200, headers);
  }

  const stream = blobToStream("output", jobId, 0, start, end + 1);
  stream.on("error", () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  req.on("close", () => stream.destroy()); // إلغاء عند انقطاع العميل
  stream.pipe(res);
};
