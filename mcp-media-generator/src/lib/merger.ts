/**
 * خدمة دمج الفيديو — Video Merger API v2 (العميل)
 * العنوان من MERGER_API_BASE، بلا مفاتيح أو توثيق.
 * المخرجات: MP4 (H.264 + AAC) حتى 1080p — لا resolution/fps (الناتج مثبّت من الخدمة).
 * القواعد الحتمية:
 * - أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري — لا إعادة محاولة
 * - أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة → استمر بالاستعلام حتى انتهاء النافذة
 * - 404 عند المتابعة = فشل نهائي (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)
 */
import { insertTask, getTask, updateTask, newTaskId } from "./turso";
import type { ProgressNotifier } from "./generation";

const MERGER_BASE = (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");

/** قفل في الذاكرة يمنع تزامن نداء process بين runMerge و get_task */
const processInFlight: Set<string> = new Set();

export function mergerBase(): string {
  return MERGER_BASE;
}

/** فحص جهوزية خدمة الدمج عبر GET /api/config بمهلة 4 ثوانٍ */
export async function mergerHealthy(): Promise<boolean> {
  if (!MERGER_BASE) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${MERGER_BASE}/api/config`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------------------- تحليل الحالة الدفاعي (7.2) ---------------------- */

const DONE_SET = new Set(["done", "completed", "complete", "success", "succeeded", "finished"]);
const FAIL_SET = new Set(["error", "failed", "failure", "cancelled", "canceled"]);

interface MergeStatus {
  state: "queued" | "processing" | "done" | "failed";
  progress: number; // 0..100
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
}

/** تحليل استجابة GET /api/jobs/{id} بشكل دفاعي */
function parseJobStatus(body: Record<string, unknown>): MergeStatus {
  // قد يرد الجسم فيه error بدون حقل status → عاملها failed فورًا
  const err = typeof body.error === "string" && body.error ? body.error : undefined;
  const rawStatus = typeof body.status === "string" ? body.status.toLowerCase() : "";
  const rawProgress = typeof body.progress === "number" ? body.progress : undefined;
  // progress قد يأتي كسرًا 0..1 → اضربه في 100
  let progress = rawProgress ?? 0;
  if (progress > 0 && progress <= 1) progress = Math.round(progress * 100);
  progress = Math.max(0, Math.min(100, Math.round(progress)));

  const videoUrl = typeof body.videoUrl === "string" ? body.videoUrl : undefined;
  const downloadUrl = typeof body.downloadUrl === "string" ? body.downloadUrl : undefined;

  if (err && !rawStatus) {
    return { state: "failed", progress, error: err };
  }
  if (DONE_SET.has(rawStatus)) {
    return { state: "done", progress: 100, videoUrl, downloadUrl };
  }
  if (FAIL_SET.has(rawStatus)) {
    return { state: "failed", progress, error: err ?? `أعادت خدمة الدمج الحالة: ${rawStatus}` };
  }
  // queued | uploading | processing | غير معروف → قيد المعالجة
  return { state: rawStatus === "queued" ? "queued" : "processing", progress, videoUrl, downloadUrl, error: err };
}

/** رابط النتيجة النهائي: فضّل videoUrl ثم downloadUrl، ثم ركّب الرابط من jobId (الاحتياطي دائمًا نص صالح) */
function finalUrl(jobId: string, status: MergeStatus): string {
  return status.videoUrl || status.downloadUrl || `${MERGER_BASE}/api/jobs/${jobId}/video`;
}

/* ------------------------------ التحقق الصارم ------------------------------ */

export interface MergeInput {
  urls?: string[];
  task_ids?: string[];
  wait_seconds?: number;
}

export type MergeValidation =
  | { ok: true; urls: string[] }
  | { ok: false; reason: string };

/** التحقق الصارم: ≥2 وكلها http/https مباشرة وعامة، و ≤10 */
export async function validateMergeInput(input: MergeInput): Promise<MergeValidation> {
  let urls: string[] = [];

  // روابط task_ids أولًا ثم urls المباشرة بنفس ترتيبها
  if (input.task_ids?.length) {
    const { listRecentTasks } = await import("./turso");
    for (const tid of input.task_ids) {
      const t = await getTask(tid);
      if (!t) {
        return { ok: false, reason: `المهمة ${tid} غير موجودة في قاعدة البيانات` };
      }
      if (t.type !== "video") {
        return { ok: false, reason: `المهمة ${tid} ليست مهمة فيديو — الدمج يقبل مهام فيديو مكتملة فقط` };
      }
      if (t.status !== "completed" || !t.result_urls_json) {
        return { ok: false, reason: `المهمة ${tid} ليست مكتملة بعد — أكملها أولًا ثم ادمجها (الحالة الحالية: ${t.status})` };
      }
      const u = JSON.parse(t.result_urls_json) as string[];
      if (!u.length) {
        return { ok: false, reason: `المهمة ${tid} مكتملة لكن بلا روابط نتيجة` };
      }
      urls.push(u[0]);
    }
  }
  if (input.urls?.length) {
    urls.push(...input.urls);
  }

  if (urls.length < 2) {
    return {
      ok: false,
      reason: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.",
    };
  }
  if (urls.length > 10) {
    return {
      ok: false,
      reason: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).",
    };
  }
  const bad = urls.find(
    (u) => !/^https?:\/\/.+/i.test(u) || /localhost|127\.0\.0\.1|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\./i.test(u)
  );
  if (bad) {
    return {
      ok: false,
      reason: "❌ كل الروابط يجب أن تكون روابط http/https مباشرة وعامة (لا نطاقات داخلية).",
    };
  }
  return { ok: true, urls };
}

/* --------------------------------- runMerge --------------------------------- */

export type MergeOutcome =
  | { status: "completed"; taskId: string; urls: string[] }
  | { status: "processing"; taskId: string }
  | { status: "failed"; taskId: string; reason: string };

/** تدفق الدمج الكامل: تحقق → تسجيل → POST /api/jobs → process مرة واحدة → استعلام كل 3 ثوانٍ */
export async function runMerge(
  input: MergeInput,
  notify?: ProgressNotifier
): Promise<MergeOutcome | { status: "invalid"; reason: string }> {
  const check = await validateMergeInput(input);
  if (!check.ok) return { status: "invalid", reason: check.reason };

  if (!MERGER_BASE) {
    return {
      status: "invalid",
      reason: "خدمة الدمج غير مهيأة — اضبط متغير البيئة MERGER_API_BASE في .env ثم أعد المحاولة.",
    };
  }

  const waitSeconds = Math.max(0, Math.min(240, input.wait_seconds ?? 60));
  const taskId = newTaskId();

  // تسجيل مهمة type="merge", provider="merger", model="video-merger" أولًا
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${check.urls.length} مقاطع بالترتيب`,
    params_json: JSON.stringify({ urls: check.urls, wait_seconds: waitSeconds }),
    status: "processing",
    progress: 0,
  });

  // إنشاء مهمة الدمج في الخدمة
  let jobId: string;
  try {
    const res = await fetch(`${MERGER_BASE}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos: check.urls }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.jobId !== "string") {
      const err = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
      // خطأ معلن من الخدمة = فشل نهائي فوري
      await updateTask(taskId, { status: "failed", error_message: err.slice(0, 500) });
      return { status: "failed", taskId, reason: err };
    }
    jobId = body.jobId;
  } catch (e) {
    // خطأ شبكة من طرفنا = مؤقت — نُبقي المهمة جارية وسيُعاد من get_task
    await updateTask(taskId, { provider_task_id: null, error_message: `خطأ شبكة مؤقت: ${(e as Error).message}`.slice(0, 500) });
    return { status: "processing", taskId };
  }

  await updateTask(taskId, { provider_task_id: jobId, progress: 5 });

  // إطلاق process خلفيًا وبمرة واحدة فقط (قفل الذاكرة)
  void triggerProcess(jobId);

  // نافذة الانتظار: استعلام كل 3 ثوانٍ مع بث تقدم وكتابة الحالة في Turso فورًا
  const deadline = Date.now() + waitSeconds * 1000;
  let lastNotify = 0;
  while (Date.now() < deadline) {
    await sleep(3000);
    const snap = await pollMergeJob(jobId);
    if (snap.state === "done") {
      const url = finalUrl(jobId, snap);
      await updateTask(taskId, {
        status: "completed",
        result_urls_json: JSON.stringify([url]),
        progress: 100,
      });
      return { status: "completed", taskId, urls: [url] };
    }
    if (snap.state === "failed") {
      await updateTask(taskId, { status: "failed", error_message: (snap.error ?? "فشل دمج غير معروف").slice(0, 500) });
      return { status: "failed", taskId, reason: snap.error ?? "فشل دمج غير معروف" };
    }
    const prog = snap.state === "queued" ? Math.min(snap.progress, 10) : Math.max(10, snap.progress);
    await updateTask(taskId, { progress: prog }).catch(() => {});
    const now = Date.now();
    if (notify && now - lastNotify >= 2800) {
      lastNotify = now;
      notify(prog, 100, `قيد الدمج… ${prog}%`);
    }
  }

  return { status: "processing", taskId };
}

/** تنفيذ POST .../process مرة واحدة لكل مهمة (قفل في الذاكرة) */
async function triggerProcess(jobId: string): Promise<void> {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  try {
    await fetch(`${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" });
  } catch {
    // خطأ الشبكة هنا مؤقت — get_task سينفّذ process لاحقًا إن لم يُنفَّذ
  } finally {
    processInFlight.delete(jobId);
  }
}

/** استعلام حالة مهمة الدمج من الخدمة بشكل دفاعي */
async function pollMergeJob(jobId: string): Promise<MergeStatus> {
  try {
    const res = await fetch(`${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}`);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 404) {
      return { state: "failed", progress: 0, error: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" };
    }
    if (!res.ok || (typeof body.error === "string" && body.error && !("status" in body))) {
      const err = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
      return { state: "failed", progress: 0, error: err };
    }
    return parseJobStatus(body);
  } catch (e) {
    // خطأ شبكتنا = مؤقت — استمر بالاستعلام حتى انتهاء النافذة
    return { state: "processing", progress: 20, error: `خطأ شبكة مؤقت: ${(e as Error).message}` };
  }
}

/* --------------------------- refreshMergeTask --------------------------- */

/** متابعة مهمة دمج من get_task: حدّث من الخدمة، نفّذ process إن لم يُنفَّذ، و404 فشل نهائي */
export async function refreshMergeTask(
  taskId: string,
  notify?: ProgressNotifier
): Promise<"completed" | "processing" | "failed"> {
  const task = await getTask(taskId);
  if (!task) return "failed";
  if (task.status === "completed" || task.status === "failed") return task.status as "completed" | "failed";
  if (!MERGER_BASE) return "processing";

  const jobId = task.provider_task_id;
  if (!jobId) {
    // لم تُنشأ مهمة الخدمة بعد (خطأ شبكة عند الإنشاء) — أعد المحاولة الآن
    const urls = JSON.parse(task.params_json || "{}") as { urls?: string[] };
    if (!urls.urls?.length) return "processing";
    try {
      const res = await fetch(`${MERGER_BASE}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videos: urls.urls }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok && typeof body.jobId === "string") {
        await updateTask(taskId, { provider_task_id: body.jobId, error_message: null, progress: 5 });
        void triggerProcess(body.jobId);
      } else {
        const err = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
        await updateTask(taskId, { status: "failed", error_message: err.slice(0, 500) });
        return "failed";
      }
    } catch {
      // مؤقت — المحاولة في get_task القادم
    }
    return (await getTask(taskId))?.status === "failed" ? "failed" : "processing";
  }

  const snap = await pollMergeJob(jobId);
  if (snap.state === "done") {
    const url = finalUrl(jobId, snap);
    await updateTask(taskId, {
      status: "completed",
      result_urls_json: JSON.stringify([url]),
      progress: 100,
    });
    return "completed";
  }
  if (snap.state === "failed") {
    await updateTask(taskId, { status: "failed", error_message: (snap.error ?? "فشل دمج").slice(0, 500) });
    return "failed";
  }

  // إن كانت processing ولم يُنفَّذ process بعد فنفّذه الآن (القفل يمنع التزامن)
  if (snap.state === "processing" && !processInFlight.has(jobId)) {
    void triggerProcess(jobId);
  }

  await updateTask(taskId, { progress: Math.max(10, snap.progress) }).catch(() => {});
  const now = Date.now();
  if (notify && now % 6000 < 3000) {
    notify(Math.max(10, snap.progress), 100, `قيد الدمج… ${Math.max(10, snap.progress)}%`);
  }
  return "processing";
}
