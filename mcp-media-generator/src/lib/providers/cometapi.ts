/**
 * مزود CometAPI (api.cometapi.com) — OpenAI-compatible:
 * - الصور: POST /v1/images/generations (متزامنة — تعيد data[].url أو data[].b64_json فورًا)
 * - الفيديو: POST /v1/videos (multipart/form-data: model, prompt, seconds, input_reference)
 *   ثم GET /v1/videos/{id} → {status: queued|in_progress|completed|failed|error, progress, video_url}
 * نلتزم بالأشكال الموثقة الرسمية فقط ولا نرسل حقولًا غير موثقة.
 */
import { ProviderErrorImpl } from "../keys";
import type { ProviderInput } from "./kie";

const COMET_BASE = "https://api.cometapi.com/v1";

async function cometError(res: Response): Promise<ProviderErrorImpl> {
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as Record<string, unknown>;
    // رسائل OpenAI-style: {error: {message}} أو {message}
    if (body?.error && typeof body.error === "object") {
      const m = (body.error as Record<string, unknown>).message;
      if (typeof m === "string") message = m;
    } else if (typeof body.message === "string") {
      message = body.message;
    } else if (typeof body.error === "string") {
      message = body.error;
    }
  } catch {
    /* جسم غير JSON */
  }
  // التصنيف الابتدائي temporary — يُعاد التصنيف الصحيح في classifyProviderError
  return new ProviderErrorImpl(res.status, message, "temporary");
}

/* --------------------------------- الصور --------------------------------- */

/**
 * توليد صورة متزامن — تعيد الروابط فورًا.
 * ملاحظة: نماذج GPT Image تعيد b64_json؛ هنا لا ننزّل أي وسائط على السيرفر إطلاقًا،
 * لذا نبني رابط data: URI نتيجة (تبقى في الذاكرة/القاعدة كسلسلة) دون أي تنزيل ملفات.
 */
export async function createImageSync(
  key: string,
  model: string,
  input: ProviderInput
): Promise<{ urls: string[] }> {
  let res: Response;
  try {
    res = await fetch(`${COMET_BASE}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        prompt: input.prompt,
        n: 1,
        ...(input.output_format ? { output_format: input.output_format } : {}),
        ...(input.background && input.background !== "auto" ? { background: input.background } : {}),
      }),
    });
  } catch (e) {
    throw new ProviderErrorImpl(0, `فشل الاتصال بـ CometAPI: ${(e as Error).message}`, "temporary");
  }
  if (!res.ok) throw await cometError(res);

  const body = (await res.json()) as {
    data?: Array<{ url?: string; b64_json?: string }>;
  };
  const urls: string[] = [];
  for (const d of body.data ?? []) {
    if (d.url) urls.push(d.url);
    else if (d.b64_json) urls.push(`data:image/png;base64,${d.b64_json}`);
  }
  if (urls.length === 0) {
    throw new ProviderErrorImpl(500, "استجابة CometAPI بلا نتائج صور", "temporary");
  }
  return { urls };
}

/* --------------------------------- الفيديو --------------------------------- */

/** إنشاء مهمة فيديو غير متزامنة عبر POST /v1/videos (multipart كما في التوثيق الرسمي) */
export async function createTask(
  key: string,
  model: string,
  input: ProviderInput
): Promise<{ providerTaskId: string }> {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", input.prompt);
  if (typeof input.duration === "number" && input.duration > 0) {
    form.append("seconds", String(input.duration));
  }
  // الصورة الأولى (image-to-video) — input_reference يقبل روابط عامة
  if (input.image_url) {
    form.append("input_reference", input.image_url);
  }

  let res: Response;
  try {
    res = await fetch(`${COMET_BASE}/videos`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
  } catch (e) {
    throw new ProviderErrorImpl(0, `فشل الاتصال بـ CometAPI: ${(e as Error).message}`, "temporary");
  }
  if (!res.ok) throw await cometError(res);

  const body = (await res.json()) as { id?: string; task_id?: string };
  const taskId = body.task_id ?? body.id;
  if (typeof taskId !== "string" || !taskId) {
    throw new ProviderErrorImpl(500, "استجابة CometAPI بلا معرّف مهمة", "temporary");
  }
  return { providerTaskId: taskId };
}

const TERMINAL_DONE = new Set(["completed", "complete", "success", "succeeded", "finished"]);
const TERMINAL_FAIL = new Set(["failed", "error", "cancelled", "canceled"]);

/** استعلام حالة مهمة الفيديو عبر GET /v1/videos/{id} */
export async function checkTask(
  key: string,
  providerTaskId: string
): Promise<{ status: "processing" | "completed" | "failed"; urls?: string[]; error?: string; progress?: number }> {
  let res: Response;
  try {
    res = await fetch(`${COMET_BASE}/videos/${encodeURIComponent(providerTaskId)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch (e) {
    throw new ProviderErrorImpl(0, `فشل الاتصال بـ CometAPI: ${(e as Error).message}`, "temporary");
  }
  if (!res.ok) throw await cometError(res);

  const body = (await res.json()) as {
    status?: string;
    progress?: number;
    video_url?: string;
  };
  const status = (body.status ?? "").toLowerCase();
  const progress = typeof body.progress === "number" ? body.progress : undefined;

  if (TERMINAL_DONE.has(status)) {
    const urls = body.video_url ? [body.video_url] : [];
    return { status: "completed", urls, progress: 100 };
  }
  if (TERMINAL_FAIL.has(status)) {
    return { status: "failed", error: `أعاد المزود الحالة: ${status}` };
  }
  return { status: "processing", progress };
}
