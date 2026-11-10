/**
 * منسّق التوليد (runGeneration + refreshTask)
 * قواعد التبديل «لا توقف أبدًا» (4.3):
 * - جرّب المرشحين بالترتيب التسلسلي حسب ترتيب إضافة المفاتيح؛ أول نجاح يربط المهمة بالمزود والمفتاح
 * - كل محاولة (نجاح/فشل + الفئة) تُسجَّل في attempts_json وعدّادات المفتاح تُحدَّث دائمًا
 * - فشل منتصف المهمة بنمط مفتاح/رصيد → إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي
 * - فشل الإنشاء على كل المفاتيح → المهمة تبقى processing «بانتظار توفر مفتاح صالح…»
 *   وتُعاد المحاولة مع كل get_task (تهدئة ~45 ثانية)
 * - نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا
 */
import {
  insertTask,
  getTask,
  updateTask,
  parseTask,
  newTaskId,
  type TaskView,
  type AttemptEntry,
  type TaskType,
} from "./turso";
import {
  getKeyPool,
  classifyProviderError,
  recordKeyResult,
  ProviderErrorImpl,
  type KeyRow,
} from "./keys";
import { normalizeModel, type ModelDef } from "./models";
import * as kie from "./providers/kie";
import * as cometapi from "./providers/cometapi";
import { refreshMergeTask } from "./merger";

export interface GenerationParams {
  model: string;            // اسم كما يرسله العميل — يُوحَّد عبر aliases
  prompt: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  image_url?: string;
  enable_audio?: boolean;
  duration?: number;
  wait_seconds?: number;
}

export interface ProgressNotifier {
  (progress: number, total: number, message: string): void;
}

export type GenerationOutcome =
  | { status: "completed"; taskId: string; urls: string[] }
  | { status: "processing"; taskId: string }
  | { status: "failed"; taskId: string; reason: string } // فشل حقيقي فقط (سياسة/معطيات)
  | { status: "no_keys"; model: string }; // لا مفاتيح نشطة — رسالة عربية للأداة

/** بناء input المزود من معطيات الأداة حسب النوع */
function buildProviderInput(type: TaskType, p: GenerationParams): kie.ProviderInput {
  const input: kie.ProviderInput = { prompt: p.prompt };
  if (type === "image") {
    if (p.aspect_ratio && p.aspect_ratio !== "auto") input.aspect_ratio = p.aspect_ratio;
    if (p.resolution) input.resolution = p.resolution;
    if (p.background && p.background !== "auto") input.background = p.background;
    if (p.output_format) input.output_format = p.output_format;
  } else {
    if (p.aspect_ratio && p.aspect_ratio !== "auto") input.aspect_ratio = p.aspect_ratio;
    if (p.resolution) input.resolution = p.resolution;
    if (p.image_url) input.image_url = p.image_url;
    if (p.enable_audio !== undefined) input.enable_audio = p.enable_audio;
    if (p.duration) input.duration = p.duration;
  }
  return input;
}

/** تسجيل محاولة في attempts_json + تحديث عدّادات المفتاح */
async function recordAttempt(
  taskId: string,
  key: KeyRow,
  provider: string,
  ok: boolean,
  error?: { class: string; message: string }
): Promise<void> {
  const entry: AttemptEntry = {
    provider,
    keyId: key.id,
    keyLabel: key.label || key.provider,
    ok,
    ...(error ? { errorClass: error.class, error: error.message.slice(0, 300) } : {}),
    at: new Date().toISOString(),
  };
  await updateTask(taskId, { append_attempt: entry }).catch(() => {});
  await recordKeyResult(key.id, ok, error ? { class: error.class as never, message: error.message } : undefined);
}

/** نمط مشكلات مفتاح/رصيد في رسائل فشل منتصف المهمة (4.3.2) */
const KEY_BALANCE_FAIL_PATTERN = /insufficient|balance|credit|quota|402|401|unauthorized|exhausted|充值/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * إنشاء المهمة على أول مفتاح يعمل بالترتيب التسلسلي.
 * يعيد الموفر الناجح أو null إن فشل الجميع (المهمة تبقى processing بانتظار مفتاح صالح).
 * startAfterKeyId: استئناف من المفتاح التالي بعد فشل منتصف المهمة.
 */
async function createOnFirstWorkingKey(
  taskId: string,
  model: ModelDef,
  input: kie.ProviderInput,
  startAfterKeyId?: string | null
): Promise<{ provider: string; key: KeyRow; providerTaskId?: string; syncUrls?: string[] } | null> {
  const pool = await getKeyPool(model.providers);
  let candidates = pool;
  if (startAfterKeyId) {
    const idx = pool.findIndex((k) => k.id === startAfterKeyId);
    if (idx >= 0) candidates = pool.slice(idx + 1);
  }

  for (const key of candidates) {
    const provider = key.provider as "kie" | "cometapi";
    const providerModel = model.providerModel[provider] || model.canonical;
    try {
      // صور CometAPI متزامنة — تعيد النتيجة فورًا
      if (model.type === "image" && provider === "cometapi") {
        const { urls } = await cometapi.createImageSync(key.api_key, providerModel, input);
        await recordAttempt(taskId, key, provider, true);
        return { provider, key, syncUrls: urls };
      }
      const { providerTaskId } =
        provider === "kie"
          ? await kie.createTask(key.api_key, providerModel, input)
          : await cometapi.createTask(key.api_key, providerModel, input);
      await recordAttempt(taskId, key, provider, true);
      return { provider, key, providerTaskId };
    } catch (e) {
      const pe = e as ProviderErrorImpl;
      const cls = classifyProviderError(pe.status ?? 0, pe.message ?? String(e));
      await recordAttempt(taskId, key, provider, false, { class: cls, message: pe.message ?? String(e) });

      if (cls === "params") {
        // خطأ معطيات — تبديل المفاتيح لن يحلّه: فشل فوري نهائي
        await updateTask(taskId, { status: "failed", error_message: (pe.message ?? "خطأ معطيات").slice(0, 500) });
        throw new ParamsFailure(pe.message ?? "خطأ معطيات");
      }
      // disabled / exhausted / provider / temporary → التبديل الصامت للمفتاح التالي
      continue;
    }
  }
  return null; // فشل على كل المرشحين
}

/** خطأ معطيات نهائي — يوقف كل شيء فورًا */
class ParamsFailure extends Error {}

/** التدفق الكامل لأداة generate_image / generate_video */
export async function runGeneration(
  params: GenerationParams,
  notify?: ProgressNotifier
): Promise<GenerationOutcome> {
  // 1) توحيد اسم الموديل — غير معروف → خطأ معطيات فوري
  const model = normalizeModel(params.model);
  const type = model.type;

  const waitSeconds = Math.max(0, Math.min(240, params.wait_seconds ?? (type === "image" ? 90 : 25)));
  const input = buildProviderInput(type, params);

  // 2) الحمولة فارغة؟ → رد no_keys (قبل تسجيل المهمة — لا شيء لنُجرب به)
  const pool = await getKeyPool(model.providers);
  if (pool.length === 0) {
    return { status: "no_keys", model: model.canonical };
  }

  // 3) تسجيل المهمة في Turso قبل أي نداء خارجي — تبقى قابلة للتتبع مهما حدث
  const taskId = newTaskId();
  await insertTask({
      id: taskId,
      model: model.canonical,
      type,
      prompt: params.prompt,
      params_json: JSON.stringify({ ...params, model: model.canonical, wait_seconds: waitSeconds }),
      status: "processing",
      progress: 0,
    });

  // 4) إنشاء على المرشحين بالترتيب التسلسلي
  let bound: Awaited<ReturnType<typeof createOnFirstWorkingKey>>;
  try {
    bound = await createOnFirstWorkingKey(taskId, model, input);
  } catch (e) {
    if (e instanceof ParamsFailure) {
      return { status: "failed", taskId, reason: e.message };
    }
    throw e;
  }

  if (!bound) {
    // فشل الإنشاء على كل المفاتيح — تبقى processing برسالة داخلية، وتُعاد المحاولة مع get_task
    await updateTask(taskId, {
      error_message: "بانتظار توفر مفتاح صالح…",
    });
    return { status: "processing", taskId };
  }

  await updateTask(taskId, {
    provider: bound.provider,
    key_id: bound.key.id,
    provider_task_id: bound.providerTaskId ?? null,
    progress: 5,
  });

  // صور CometAPI المتزامنة: النتيجة جاهزة فورًا
  if (bound.syncUrls) {
    await updateTask(taskId, {
      status: "completed",
      result_urls_json: JSON.stringify(bound.syncUrls),
      progress: 100,
    });
    return { status: "completed", taskId, urls: bound.syncUrls };
  }

  // 5) نافذة الانتظار: استعلام كل 3 ثوانٍ + بث تقدم عربي
  const deadline = Date.now() + waitSeconds * 1000;
  let lastNotify = 0;
  let checkKey = bound.key;

  while (Date.now() < deadline) {
    await sleep(3000);
    const result = await pollOnce(taskId, model, input, checkKey);
    if (result.kind === "completed") {
      await updateTask(taskId, { status: "completed", result_urls_json: JSON.stringify(result.urls) });
      return { status: "completed", taskId, urls: result.urls };
    }
    if (result.kind === "failed") {
      await updateTask(taskId, { status: "failed", error_message: result.reason.slice(0, 500) });
      return { status: "failed", taskId, reason: result.reason };
    }
    if (result.kind === "switched") {
      // فشل مفتاح/رصيد في منتصف المهمة — أُعيد الإنشاء بنفس task_id على المفتاح التالي
      checkKey = result.newKey;
    }
    if (result.kind === "processing") {
      // بث التقدم كل ~3 ثوانٍ
      const now = Date.now();
      if (notify && now - lastNotify >= 2800) {
        lastNotify = now;
        notify(result.progress, 100, `قيد التوليد… ${result.progress}%`);
      }
      await updateTask(taskId, { progress: result.progress }).catch(() => {});
    }
  }

  // 6) انتهت النافذة — المهمة جارية والعميل يتابع بـ get_task
  return { status: "processing", taskId };
}

type PollResult =
  | { kind: "processing"; progress: number }
  | { kind: "completed"; urls: string[] }
  | { kind: "failed"; reason: string }
  | { kind: "switched"; newKey: KeyRow };

/** استعلام واحد من المزود + معالجة كل الحالات (بما فيها التبديل عند فشل مفتاح/رصيد) */
async function pollOnce(
  taskId: string,
  model: ModelDef,
  input: kie.ProviderInput,
  key: KeyRow
): Promise<PollResult> {
  const task = await getTask(taskId);
  if (!task || !task.provider_task_id) {
    return { kind: "processing", progress: 10 };
  }
  const provider = (task.provider ?? "kie") as "kie" | "cometapi";
  try {
    const check =
      provider === "kie"
        ? await kie.checkTask(key.api_key, task.provider_task_id)
        : await cometapi.checkTask(key.api_key, task.provider_task_id);

    if (check.status === "completed" && check.urls?.length) {
      return { kind: "completed", urls: check.urls };
    }
    if (check.status === "failed") {
      const msg = check.error ?? "فشل المزود دون تفاصيل";
      if (KEY_BALANCE_FAIL_PATTERN.test(msg)) {
        // فشل مفتاح/رصيد في منتصف المهمة → إعادة إنشاء بنفس task_id على المفتاح التالي
        const next = await createOnFirstWorkingKey(taskId, model, input, key.id);
        if (next) {
          await updateTask(taskId, {
            provider: next.provider,
            key_id: next.key.id,
            provider_task_id: next.providerTaskId ?? null,
            error_message: null,
            progress: 5,
          });
          return { kind: "switched", newKey: next.key };
        }
        // لا مفاتيح متبقية — تبقى processing بانتظار مفتاح صالح (لا فشل يُعرض للعميل)
        await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
        return { kind: "processing", progress: 10 };
      }
      // فشل حقيقي (سياسة محتوى/معطيات) — نهائي
      return { kind: "failed", reason: msg };
    }
    return {
      kind: "processing",
      progress: typeof check.progress === "number" ? Math.max(5, Math.min(99, check.progress)) : 40,
    };
  } catch (e) {
    const pe = e as ProviderErrorImpl;
    const cls = classifyProviderError(pe.status ?? 0, pe.message ?? String(e));
    await recordKeyResult(key.id, false, { class: cls, message: pe.message ?? String(e) }).catch(() => {});
    if (cls === "disabled" || cls === "exhausted") {
      // مفتاح رُفض أثناء المتابعة — انتقل للمفتاح التالي بنفس المهمة
      const next = await createOnFirstWorkingKey(taskId, model, input, key.id);
      if (next) {
        await updateTask(taskId, {
          provider: next.provider,
          key_id: next.key.id,
          provider_task_id: next.providerTaskId ?? null,
          progress: 5,
        });
        return { kind: "switched", newKey: next.key };
      }
      await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
      return { kind: "processing", progress: 10 };
    }
    // temporary/provider — نستمر بالاستعلام (المفتاح يبقى سليمًا في temporary)
    return { kind: "processing", progress: 40 };
  }
}

/* --------------------------- get_task → refreshTask --------------------------- */

export type RefreshOutcome =
  | { status: "not_found" }
  | { status: "completed"; task: TaskView }
  | { status: "processing"; task: TaskView }
  | { status: "failed"; task: TaskView };

/** هدئة إعادة المحاولة عند انتظار مفتاح صالح (ثوانٍ) */
const RETRY_COOLDOWN_SEC = 45;

/** تُحدّث المهمة الجارية حية من المزود/خدمة الدمج ثم تعيد صياغة حالتها */
export async function refreshTask(taskId: string, notify?: ProgressNotifier): Promise<RefreshOutcome> {
  const row = await getTask(taskId);
  if (!row) return { status: "not_found" };

  // مهام الدمج تُحدَّث من خدمة الدمج
  if (row.type === "merge") {
    const r = await refreshMergeTask(taskId, notify);
    const fresh = await getTask(taskId);
    if (!fresh) return { status: "not_found" };
    const view = parseTask(fresh);
    if (r === "completed") return { status: "completed", task: view };
    if (r === "failed") return { status: "failed", task: view };
    return { status: "processing", task: view };
  }

  if (row.status === "completed" || row.status === "failed") {
    return { status: row.status, task: parseTask(row) };
  }

  // المهمة جارية
  const model = normalizeModel(row.model);

  if (!row.provider_task_id) {
    // لم يُنجَز الإنشاء بعد (بانتظار مفتاح صالح) — أعد المحاولة بعد التهدئة
    const last = new Date(row.updated_at + "Z").getTime();
    if (Date.now() - last >= RETRY_COOLDOWN_SEC * 1000) {
      const params = JSON.parse(row.params_json || "{}") as GenerationParams;
      const input = buildProviderInput(model.type, { ...params, model: row.model });
      try {
        const bound = await createOnFirstWorkingKey(taskId, model, input);
        if (bound) {
          await updateTask(taskId, {
            provider: bound.provider,
            key_id: bound.key.id,
            provider_task_id: bound.providerTaskId ?? null,
            error_message: null,
            progress: 5,
          });
          if (bound.syncUrls) {
            await updateTask(taskId, {
              status: "completed",
              result_urls_json: JSON.stringify(bound.syncUrls),
            });
            const fresh = await getTask(taskId);
            return { status: "completed", task: parseTask(fresh!) };
          }
        }
      } catch (e) {
        if (e instanceof ParamsFailure) {
          await updateTask(taskId, { status: "failed", error_message: e.message.slice(0, 500) });
          const fresh = await getTask(taskId);
          return { status: "failed", task: parseTask(fresh!) };
        }
      }
    }
    const fresh = await getTask(taskId);
    return { status: "processing", task: parseTask(fresh!) };
  }

  // لها معرّف لدى المزود — حدّث حيًا
  const keyRow = row.key_id
    ? (await getKeyPool(model.providers)).find((k) => k.id === row.key_id) ??
      (await getKeyPool(model.providers))[0]
    : (await getKeyPool(model.providers))[0];
  if (!keyRow) {
    const fresh = await getTask(taskId);
    return { status: "processing", task: parseTask(fresh!) };
  }

  const result = await pollOnce(
    taskId,
    model,
    buildProviderInput(model.type, JSON.parse(row.params_json || "{}") as GenerationParams),
    keyRow
  );
  if (result.kind === "completed") {
    await updateTask(taskId, { status: "completed", result_urls_json: JSON.stringify(result.urls) });
  } else if (result.kind === "failed") {
    await updateTask(taskId, { status: "failed", error_message: result.reason.slice(0, 500) });
  }
  const fresh = await getTask(taskId);
  const view = parseTask(fresh!);
  if (result.kind === "completed") return { status: "completed", task: view };
  if (result.kind === "failed") return { status: "failed", task: view };
  return { status: "processing", task: view };
}
