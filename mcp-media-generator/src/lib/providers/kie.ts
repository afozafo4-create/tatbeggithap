/**
 * مزود kie.ai — Jobs API الموحد (الأشكال المقاسة فعليًا:
 *   POST https://api.kie.ai/api/v1/jobs/createTask → {"code":200,"data":{"taskId":"..."}}
 *   GET  https://api.kie.ai/api/v1/jobs/recordInfo?taskId=... → {"code":200,"data":{"state":...,"resultJson":"...","failMsg":"..."}}
 * ملاحظة: resultJson نص JSON داخل JSON يحتاج JSON.parse ثانيًا.
 */
import { ProviderErrorImpl } from "../keys";

const KIE_BASE = "https://api.kie.ai/api/v1/jobs";

export interface CreateTaskResult {
  providerTaskId: string;
}

export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderInput {
  prompt: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  image_url?: string;
  enable_audio?: boolean;
  duration?: number;
}

async function kieFetch(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${KIE_BASE}${path}`, init);
  } catch (e) {
    // انقطاع شبكة/مهلة من طرفنا = temporary
    throw new ProviderErrorImpl(0, `فشل الاتصال بـ kie.ai: ${(e as Error).message}`, "temporary");
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // جسم غير JSON
  }
  const code = typeof body.code === "number" ? body.code : res.status;
  const msg = typeof body.msg === "string" ? body.msg : `HTTP ${res.status}`;
  if (code !== 200) {
    // نرمي بالحالة الحقيقية والرسالة — التصنيف يجري في classifyProviderError
    throw new ProviderErrorImpl(code === 200 ? res.status : code, msg, "temporary");
  }
  return (body.data as Record<string, unknown>) ?? {};
}

/** إنشاء مهمة غير متزامنة (الصور والفيديو لدى kie.ai كلاهما عبر Jobs API) */
export async function createTask(
  key: string,
  model: string,
  input: ProviderInput
): Promise<CreateTaskResult> {
  const data = await kieFetch("/createTask", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model, input }),
  });
  const taskId = data.taskId;
  if (typeof taskId !== "string" || !taskId) {
    throw new ProviderErrorImpl(500, "استجابة kie.ai بلا taskId", "temporary");
  }
  return { providerTaskId: taskId };
}

/** استعلام حالة المهمة — state: waiting|queuing|generating|success|fail */
export async function checkTask(key: string, providerTaskId: string): Promise<CheckResult> {
  // ملاحظة: recordInfo يتطلب Authorization مثل createTask — إغفاله يجعل كل الاستعلامات ترجع 401
  const data = await kieFetch(`/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const state = typeof data.state === "string" ? data.state : "unknown";

  if (state === "success") {
    // resultJson نص JSON داخل JSON — نحتاج JSON.parse ثانيًا
    let urls: string[] = [];
    if (typeof data.resultJson === "string") {
      try {
        const parsed = JSON.parse(data.resultJson) as { resultUrls?: string[] };
        urls = Array.isArray(parsed.resultUrls) ? parsed.resultUrls : [];
      } catch {
        urls = [];
      }
    }
    if (urls.length === 0 && Array.isArray(data.resultUrls)) {
      urls = data.resultUrls as string[];
    }
    return { status: "completed", urls, progress: 100 };
  }

  if (state === "fail") {
    return {
      status: "failed",
      error: typeof data.failMsg === "string" && data.failMsg ? data.failMsg : "فشل المزود دون تفاصيل",
    };
  }

  // waiting | queuing | generating → قيد المعالجة
  return { status: "processing", progress: state === "generating" ? 50 : 15 };
}
