/**
 * اختبار HTTP كامل ضد خادم التطوير المحلي (server.js على 3030):
 * إنشاء مهمة من روابط → دمج → بث مع Range 206 → مهمة مختلطة (رابط + ملف مرفوع)
 * → حذف → 404 → JSON تالف → قائمة فارغة
 * التشغيل: node tests/http.js  (الخادم يجب أن يعمل على PORT=3030)
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const BASE = process.env.TEST_BASE || "http://localhost:3030";
const { ffmpegPath } = require("../lib/merge");

let passed = 0;
let failed = 0;
const results = [];
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    results.push(`✅ ${name}${extra ? " — " + extra : ""}`);
  } else {
    failed++;
    results.push(`❌ ${name}${extra ? " — " + extra : ""}`);
  }
}

async function jfetch(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

async function main() {
  /* 0) الخدمة جاهزة */
  const cfg = await jfetch(`${BASE}/api/config`);
  check("GET /api/config يعيد الحدود والجهوزية", cfg.res.ok && cfg.body.maxSources === 10 && cfg.body.ffmpeg?.configured === true);

  /* 1) مهمة روابط: إنشاء → دمج → التحقق من الناتج */
  const create = await jfetch(`${BASE}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      videos: [
        "https://www.w3schools.com/html/mov_bbb.mp4",
        "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
      ],
    }),
  });
  check("POST /api/jobs يعيد 201 مع jobId/statusUrl/processUrl", create.res.status === 201 && Boolean(create.body.jobId && create.body.statusUrl && create.body.processUrl), create.body.jobId);
  check("expiresAt موجود (24 ساعة)", Boolean(create.body.expiresAt));

  const jobId = create.body.jobId;
  const proc = await jfetch(`${BASE}/api/jobs/${jobId}/process`, { method: "POST" });
  check("POST /api/jobs/<id>/process يرجع done مباشرة", proc.res.status === 200 && proc.body.status === "done", `${proc.res.status}`);
  check("videoUrl/downloadUrl على نطاق الخدمة", typeof proc.body.videoUrl === "string" && proc.body.videoUrl.includes("/api/jobs/") && !proc.body.videoUrl.includes("localhost:" + "xxx"));
  check("size/duration/resolution موجودة", proc.body.size > 0 && proc.body.duration > 0 && /\d+x\d+/.test(proc.body.resolution || ""), `${proc.body.resolution}, ${proc.body.duration}s, ${Math.round(proc.body.size / 1024)}KB`);

  /* 2) الحالة + التقدم */
  const status = await jfetch(`${BASE}/api/jobs/${jobId}`);
  check("GET /api/jobs/<id> يعيد status=done وprogress=100", status.body.status === "done" && Number(status.body.progress) === 100);

  /* 3) بث الناتج مع Range 206 */
  const full = await fetch(`${BASE}/api/jobs/${jobId}/video`);
  check("بث الفيديو 200 مع Content-Length", full.status === 200 && Boolean(full.headers.get("content-length")));
  const ranged = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: "bytes=0-1023" } });
  const buf = Buffer.from(await ranged.arrayBuffer());
  check("Range 206 + Content-Range صحيح", ranged.status === 206 && ranged.headers.get("content-range") === `bytes 0-1023/${full.headers.get("content-length")}` && buf.length === 1024);
  const tail = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: "bytes=-500" } });
  const tailBuf = Buffer.from(await tail.arrayBuffer());
  check("لاحقة Range (-500) تعيد آخر 500 بايت", tail.status === 206 && tailBuf.length === 500);
  const dl = await fetch(`${BASE}/api/jobs/${jobId}/video?download=1`);
  check("?download=1 يضبط Content-Disposition", dl.headers.get("content-disposition")?.includes("attachment") === true);

  /* 4) مهمة مختلطة: رابط + ملف مرفوع بأجزاء */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merger-http-"));
  const clip = path.join(tmp, "clip.mp4");
  execFileSync(ffmpegPath(), ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", clip]);
  const clipBuf = fs.readFileSync(clip);
  const mixed = await jfetch(`${BASE}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sources: [
        { kind: "url", url: "https://www.w3schools.com/html/mov_bbb.mp4" },
        { kind: "file", name: "clip.mp4", size: clipBuf.length, mime: "video/mp4" },
      ],
    }),
  });
  check("مهمة مختلطة تعيد uploads[] + uploadChunkBytes", mixed.res.status === 201 && Array.isArray(mixed.body.uploads) && mixed.body.uploads[1].uploadChunkBytes === 4194304);
  const mid = mixed.body.jobId;
  const upRes = await fetch(mixed.body.uploads[1].uploadUrl.replace("<CHUNK_INDEX>", "0"), {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: clipBuf,
  });
  const upBody = await upRes.json();
  check("رفع جزء الملف يعيد ok/received/complete", upRes.ok && upBody.ok === true && upBody.complete === true, `${upBody.received} bytes`);
  const mixedProc = await jfetch(`${BASE}/api/jobs/${mid}/process`, { method: "POST" });
  check("دمج المهمة المختلطة (رابط + ملف مرفوع) ينجح", mixedProc.res.status === 200 && mixedProc.body.status === "done", `${mixedProc.body.duration}s`);

  /* 5) الحذف ثم 404 */
  const del = await jfetch(`${BASE}/api/jobs/${jobId}`, { method: "DELETE" });
  check("DELETE يعيد ok ويحذف شاملًا", del.res.ok && del.body.ok === true);
  const gone = await jfetch(`${BASE}/api/jobs/${jobId}`);
  check("GET بعد الحذف يعيد 404", gone.res.status === 404);
  const goneDel = await jfetch(`${BASE}/api/jobs/${jobId}`, { method: "DELETE" });
  check("DELETE بعد الحذف يعيد 404", goneDel.res.status === 404);

  /* 6) JSON تالف */
  const bad = await fetch(`${BASE}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"videos": [broken',
  });
  const badBody = await bad.json().catch(() => ({}));
  check("JSON تالف يعيد 400 برسالة عربية", bad.status === 400 && typeof badBody.error === "string");

  /* 7) قائمة فارغة / مصادر أقل من اثنين */
  const empty = await jfetch(`${BASE}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: [] }),
  });
  check("قائمة فارغة تعيد 400 برسالة عربية", empty.res.status === 400 && empty.body.error.includes("مقطعَين"));

  /* 8) رابط داخلي مرفوض */
  const internal = await jfetch(`${BASE}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: ["http://localhost/x.mp4", "http://localhost/y.mp4"] }),
  });
  check("الروابط الداخلية مرفوضة", internal.res.status === 400 && internal.body.error.includes("عامة"));

  /* 9) رفض تجاوز حد المصادر (11 رابطًا) */
  const many = await jfetch(`${BASE}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: Array.from({ length: 11 }, (_, i) => `https://example.com/${i}.mp4`) }),
  });
  check("أكثر من 10 مقاطع مرفوض", many.res.status === 400 && many.body.error.includes("10"));

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log("\n" + results.join("\n"));
  console.log(`\n===== نتيجة اختبار HTTP: ${passed} ناجح / ${failed} فاشل =====`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("فشل تشغيل الاختبار:", e);
  process.exit(1);
});
