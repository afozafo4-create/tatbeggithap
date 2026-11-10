/**
 * تنظيف آثار الاختبار بعد e2e (معيار القبول 12):
 * - حذف كل مهام الاختبار من جدول tasks
 * - حذف مهام الدمج من خدمة الدمج عبر DELETE /api/jobs/{id}
 * - إعادة المفتاح الحقيقي إلى حالة active (بانتظار إعادة شحن الرصيد)
 */
const fs = require("fs");
const path = require("path");

// تحميل بيانات Turso من ملفات .env المعروفة (بدون طباعة أي أسرار)
for (const envPath of [path.join(__dirname, "..", ".env"), path.join(__dirname, "..", "mini-services/video-merger/.env")]) {
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
const { createClient } = require("@libsql/client");

(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

  // 1) حذف مهام الدمج من خدمة الدمج قبل حذف صفوفها
  const mergeTasks = await db.execute("SELECT provider_task_id FROM tasks WHERE type = 'merge' AND provider_task_id IS NOT NULL");
  let deletedJobs = 0;
  const base = process.env.MERGER_TEST_BASE || "http://localhost:3030";
  for (const row of mergeTasks.rows) {
    const jobId = String(row.provider_task_id);
    try {
      const res = await fetch(`${base}/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
      if (res.ok || res.status === 404) deletedJobs++;
    } catch { /* الخدمة غير متاحة — نكمل */ }
  }
  console.log(`حُذفت ${deletedJobs} مهمة دمج من خدمة الدمج`);

  // 2) حذف كل مهام الاختبار (كل المهام الحالية هي آثار اختبار)
  const before = await db.execute("SELECT COUNT(*) AS n FROM tasks");
  await db.execute("DELETE FROM tasks");
  console.log(`حُذفت ${before.rows[0].n} مهمة من قاعدة البيانات`);

  // 3) المفتاح الحقيقي يعود active — بانتظار إعادة شحن الرصيد من المستخدم
  const keys = await db.execute("SELECT id FROM api_keys WHERE provider = 'kie'");
  for (const k of keys.rows) {
    await db.execute({ sql: "UPDATE api_keys SET status = 'active' WHERE id = ?", args: [k.id] });
  }
  console.log(`أُعيد ${keys.rows.length} مفتاح إلى حالة active`);

  // تحقق نهائي
  const after = await db.execute("SELECT COUNT(*) AS n FROM tasks");
  const keysFinal = await db.execute("SELECT status, COUNT(*) AS n FROM api_keys GROUP BY status");
  console.log("المهام المتبقية:", after.rows[0].n, "| المفاتيح:", keysFinal.rows.map((r) => `${r.status}=${r.n}`).join(", "));
})().catch((e) => { console.error("فشل التنظيف:", e.message); process.exit(1); });
