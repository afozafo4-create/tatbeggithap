/**
 * اختبار e2e شامل للمشروع B (MCP Media Generator) عبر مسار /mcp الحقيقي.
 * مراحل: initialize → tools/list → generate_image → nano-banana-pro →
 *        اختبار التبديل التسلسلي (مفتاح خاطئ أولًا) → generate_video → merge_videos (urls + task_ids) → list_media
 * التشغيل: node scripts/e2e-mcp.mjs <phase1|phase2|all>
 */
const BASE = process.env.TEST_BASE || "http://localhost:3000";
const MERGER_BASE = process.env.MERGER_TEST_BASE || "http://localhost:3030";
const KIE_KEY = process.env.KIE_TEST_KEY; // المفتاح الحقيقي (يُمرَّر من المتغيرات — لا يُطبع أبدًا)
const BAD_KEY = "invalid-key-for-failover-test-0000";

let passed = 0, failed = 0;
const results = [];
function check(name, cond, extra = "") {
  if (cond) { passed++; results.push(`✅ ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; results.push(`❌ ${name}${extra ? " — " + extra : ""}`); }
  console.log(results[results.length - 1]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------- عميل MCP مبسّط (SSE أو JSON) ------------------------- */
let sessionId = null;

async function mcpRaw(method, params, id, opts = {}) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: id ?? null, method, params }),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const ctype = res.headers.get("content-type") || "";
  if (!opts.raw) {
    const text = await res.text();
    if (ctype.includes("text/event-stream")) {
      // استخراج آخر حدث data من تيار SSE
      const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
      const last = dataLines[dataLines.length - 1];
      return { status: res.status, body: last ? JSON.parse(last.slice(5).trim()) : null };
    }
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  return { status: res.status, res };
}

async function initialize() {
  sessionId = null;
  const r = await mcpRaw("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "e2e-test", version: "1.0" },
  }, 1);
  check("initialize ينجح ويعيد معلومات الخادم", r.body?.result?.serverInfo?.name === "media-generator-mcp", JSON.stringify(r.body?.result?.serverInfo ?? {}));
  await mcpRaw("notifications/initialized", {}, null);
  return r;
}

async function callTool(name, args, timeoutMs = 200000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method: "tools/call", params: { name, arguments: args } }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
      const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
      const last = dataLines[dataLines.length - 1];
      return JSON.parse(last.slice(5).trim());
    }
    return JSON.parse(text);
  } finally { clearTimeout(t); }
}

const toolText = (r) => r?.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
const isError = (r) => Boolean(r?.result?.isError);
const urlIn = (text) => (text.match(/https?:\/\/[^\s)\]]+/g) ?? []);

/* -------------------------------- المراحل -------------------------------- */

async function phase1() {
  console.log("=== المرحلة 1: التهيئة والأدوات والصور ===");
  const init = await initialize();

  const tools = await mcpRaw("tools/list", {}, 2);
  const names = tools.body?.result?.tools?.map((t) => t.name) ?? [];
  check("tools/list يعرض الأدوات الخمس", ["generate_image", "generate_video", "merge_videos", "get_task", "list_media"].every((n) => names.includes(n)), names.join(", "));

  const mergeTool = tools.body?.result?.tools?.find((t) => t.name === "merge_videos");
  const mergeSchema = JSON.stringify(mergeTool?.inputSchema ?? {});
  check("merge_videos بلا resolution/fps وبحد 10", !/resolution|fps/i.test(mergeSchema) && /"maxItems":10/.test(mergeSchema));
  check("initialize يرسل SERVER_INSTRUCTIONS", typeof init.body?.result?.instructions === "string" && init.body.result.instructions.includes("automatically switches API keys"));

  // 1) توليد صورة حقيقية بالموديل الأساسي
  let r = await callTool("generate_image", {
    prompt: "لوحة إعلانات رقمية عصرية في مدينة مستقبلية وقت الغروب بإضاءة سينمائية",
    aspect_ratio: "16:9", wait_seconds: 110,
  });
  let text = toolText(r);
  check("generate_image يكتمل برابط حقيقي", !isError(r) && urlIn(text).some((u) => /^https?:\/\//.test(u) && !u.includes("localhost")), text.slice(0, 140));

  // 2) توليد صورة بالموديل الإضافي nano-banana-pro (بطلب المستخدم)
  r = await callTool("generate_image", { prompt: "A cute robot painting a picture on a canvas, studio lighting", model: "nano-banana-pro", wait_seconds: 110 });
  text = toolText(r);
  check("generate_image بموديل nano-banana-pro يكتمل", !isError(r) && urlIn(text).some((u) => /^https?:\/\//.test(u) && !u.includes("localhost")), text.slice(0, 140));
}

async function phase2() {
  console.log("=== المرحلة 2: التبديل التسلسلي للمفاتيح ===");
  await initialize();
  if (!KIE_KEY) { check("توفر المفتاح الحقيقي للمرحلة 2", false, "KIE_TEST_KEY مفقود"); return; }

  // حذف المفتاح الحقيقي ثم إضافة المفتاح الخاطئ أولًا ثم الحقيقي (الترتيب = ترتيب الإضافة)
  const keysNow = await (await fetch(`${BASE}/api/keys`)).json();
  for (const k of keysNow.keys) {
    if (k.provider === "kie") await fetch(`${BASE}/api/keys/${k.id}`, { method: "DELETE" });
  }
  const add = async (key, label) => (await (await fetch(`${BASE}/api/keys`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "kie", api_key: key, label }),
  })).json());

  const bad = await add(BAD_KEY, "مفتاح خاطئ للاختبار");
  // الانتظار > 1 ثانية حتى يختلف created_at (دقة الثانية في SQLite) ويكون الترتيب حتميًا: الخاطئ أولًا
  await sleep(1600);
  const good = await add(KIE_KEY, "kie.ai رئيسي");
  check("المفتاح الخاطئ أُضيف أولًا والحقيقي ثانيًا", bad.key?.id && good.key?.id);

  const r = await callTool("generate_image", {
    prompt: "فانوس عربي قديم مضيء في ليلة رمضان بجانب نافذة مطلة على مسجد",
    aspect_ratio: "1:1", wait_seconds: 110,
  });
  const text = toolText(r);
  check("المهمة اكتملت على المفتاح الثاني رغم فشل الأول", !isError(r) && urlIn(text).length > 0, text.slice(0, 120));
  check("لا ذكر لأي مفتاح أو رصيد في الرد", !/مفتاح|رصيد|key|balance|credit|unauthorized|401/i.test(text), "");

  const keysAfter = await (await fetch(`${BASE}/api/keys`)).json();
  const badAfter = keysAfter.keys.find((k) => k.id === bad.key.id);
  const goodAfter = keysAfter.keys.find((k) => k.id === good.key.id);
  check("المفتاح الخاطئ صار disabled تلقائيًا", badAfter?.status === "disabled", `status=${badAfter?.status}`);
  check("المفتاح الصحيح سليم ونجح استخدامه", goodAfter?.status === "active" && goodAfter.success_count >= 1, `success=${goodAfter?.success_count}`);

  // تنظيف فوري للمفتاح الخاطئ (المفتاح الحقيقي يبقى للإنتاج)
  const delRes = await fetch(`${BASE}/api/keys/${bad.key.id}`, { method: "DELETE" });
  const keysFinal = await (await fetch(`${BASE}/api/keys`)).json();
  check("حذف المفتاح الخاطئ بعد الاختبار", delRes.ok && !keysFinal.keys.some((k) => k.id === bad.key.id));
}

async function phase3() {
  console.log("=== المرحلة 3: توليد فيديو حقيقي + دمج + list_media ===");
  await initialize();
  let r, text;

  // 1) فيديو حقيقي — wait_seconds طويل ليكتمل داخل النافذة
  if (!process.env.SKIP_VIDEO) {
    const videoPrompt = "لقطة سينمائية جوية تتحرك فوق مدينة مستقبلية مضيئة بالأزرق والبنفسجي ليلاً، شاشات هولوغرام عملاقة تعرض لوحات فنية رقمية، الحركة ناعمة وسلسة، جودة 4K";
    let r = await callTool("generate_video", {
      prompt: videoPrompt, resolution: "480p", duration: 8, enable_audio: true, wait_seconds: 150,
    }, 220000);
    let text = toolText(r);
    let urls = urlIn(text).filter((u) => !u.includes("localhost"));
    if (isError(r) || urls.length === 0) {
      // استخراج task_id من الرد والاستمرار بالاستعلام كل 10 ثوانٍ
      const m = text.match(/task_id:\s*([0-9a-f-]{36})/i);
      if (m) {
        console.log("⏳ الفيديو لم يكتمل في النافذة — متابعة بـ get_task…");
        for (let i = 0; i < 30; i++) {
          await sleep(10000);
          r = await callTool("get_task", { task_id: m[1] }, 60000);
          text = toolText(r);
          urls = urlIn(text).filter((u) => !u.includes("localhost"));
          console.log(`   محاولة ${i + 1}: ${text.slice(0, 80)}`);
          if (urls.length || isError(r)) break;
        }
      }
    }
    check("generate_video ينتج فيديو حقيقي برابط صالح", urls.length > 0, urls[0]?.slice(0, 100));
    global.__videoUrl = urls[0];
    global.__videoText = text;
  } else {
    console.log("(SKIP_VIDEO=1 — توليد الفيديو الحقيقي مُتحقق منه مسبقًا والرصيد مستنفد؛ سنستخدم مهمة الفيديو الحقيقية المسجلة)");
  }

  // 2) دمج بمقطعين عامين (كما في معايير القبول)
  r = await callTool("merge_videos", {
    urls: ["https://www.w3schools.com/html/mov_bbb.mp4", "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"],
    wait_seconds: 120,
  }, 200000);
  text = toolText(r);
  const mergeUrl = urlIn(text).find((u) => /\/api\/jobs\/.+\/video/.test(u) || /localhost:3030/.test(u));
  check("merge_videos يدمج مقطعين عامين بنجاح", !isError(r) && Boolean(mergeUrl), text.slice(0, 120));
  check("تنبيه الـ 24 ساعة موجود في رد الدمج", text.includes("24 ساعة"));
  if (mergeUrl) {
    const head = await fetch(mergeUrl.replace("localhost", "127.0.0.1"), { method: "GET", headers: { Range: "bytes=0-100" } });
    check("رابط ناتج الدمج يعمل ويدعم Range", head.status === 206 || head.status === 200, `HTTP ${head.status}`);
  }

  // 3) الدمج بحل task_ids بالترتيب (فيديو مولّد + رابط مباشر)
  r = await callTool("merge_videos", {
    task_ids: ["a1000000-0000-4000-8000-000000000001"],
    urls: ["https://www.w3schools.com/html/mov_bbb.mp4"],
    wait_seconds: 120,
  }, 200000);
  text = toolText(r);
  check("merge_videos يحل task_ids بالترتيب ويدمج", !isError(r) && urlIn(text).some((u) => /localhost:3030/.test(u)), text.slice(0, 120));

  // 4) رفض مقطع واحد
  r = await callTool("merge_videos", { urls: ["https://www.w3schools.com/html/mov_bbb.mp4"] });
  check("الدمج بمقطع واحد يُرفض برسالة عربية", isError(r) && toolText(r).includes("مقطعَين على الأقل"), toolText(r).slice(0, 80));

  // 5) list_media النهائية
  r = await callTool("list_media", { limit: 10 });
  check("list_media يعيد المهام المخزنة مرتبة", !isError(r) && /أحدث الوسائط المخزنة/.test(toolText(r)), "");
}

const phase = process.argv[2] || "all";
(async () => {
  try {
    if (phase === "phase1" || phase === "all") await phase1();
    if (phase === "phase2" || phase === "all") await phase2();
    if (phase === "phase3" || phase === "all") await phase3();
    console.log(`\n===== النتيجة (${phase}): ${passed} ناجح / ${failed} فاشل =====`);
    if (global.__videoUrl) console.log("VIDEO_URL=" + global.__videoUrl);
    process.exit(failed ? 1 : 0);
  } catch (e) {
    console.error("فشل غير متوقع:", e);
    console.log(`\n===== النتيجة (${phase}): ${passed} ناجح / ${failed + 1} فاشل =====`);
    process.exit(1);
  }
})();
