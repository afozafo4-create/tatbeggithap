/** GET /api/cron — حذف المهام المنتهية (Cron يومي في vercel.json الساعة 03:00) */
const store = require("../lib/db");
const { sendJson } = require("../lib/util");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "الطريقة غير مسموحة — استخدم GET" });
  let deleted = 0;
  try {
    deleted = await store.deleteExpiredJobs();
  } catch (e) {
    return sendJson(res, 500, { error: `فشل التنظيف: ${e.message}` });
  }
  return sendJson(res, 200, { ok: true, deleted, at: new Date().toISOString() });
};
