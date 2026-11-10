/** GET /api/config — الحدود العامة + version (تُستخدم لفحص الجهوزية) */
const { limits, sendJson } = require("../lib/util");
const { ffmpegPath, ffprobePath } = require("../lib/merge");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "الطريقة غير مسموحة — استخدم GET" });
  const lim = limits();
  return sendJson(res, 200, {
    version: "2.0.0",
    outputFormat: "MP4 (H.264 CRF 18 + AAC 192k/44100Hz) حتى 1080p",
    maxSources: lim.maxSources,
    sourceMaxMB: lim.sourceMaxMB,
    outputMaxMB: lim.outputMaxMB,
    maxTotalDurationSec: lim.maxTotalDurationSec,
    uploadChunkBytes: lim.uploadChunkBytes,
    retentionHours: 24,
    ffmpeg: { configured: Boolean(ffmpegPath()), probe: Boolean(ffprobePath()) },
    database: process.env.TURSO_DATABASE_URL ? "turso-configured" : "missing",
  });
};
