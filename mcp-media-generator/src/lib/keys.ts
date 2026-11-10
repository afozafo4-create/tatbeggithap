/**
 * نظام المفاتيح المتسلسلة (قلب المشروع)
 * - الترتيب صارم حسب ترتيب الإضافة (created_at ASC, id ASC) — ليس round-robin
 * - تصنيف موحّد للأخطاء: disabled / exhausted / provider / params / temporary
 * - إخفاء المفاتيح إلزامي في كل الاستجابات (maskKey)
 */
import { getTurso, ensureSchema, type InValue } from "./turso";

export type ProviderId = "kie" | "cometapi";
export type KeyStatus = "active" | "exhausted" | "disabled";

export interface KeyRow {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

/** تمثيل آمن للمفتاح — لا يُعاد المفتاح الكامل أبدًا */
export interface KeyView {
  id: string;
  provider: string;
  label: string;
  masked_key: string;
  status: KeyStatus;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

/** إخفاء المفتاح: أول 7 أحرف + •••••••• + آخر 4 (للمفاتيح القصيرة: أول 3 + ••••) */
export function maskKey(key: string): string {
  if (key.length >= 15) {
    return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
  }
  return `${key.slice(0, 3)}••••`;
}

export function toKeyView(row: KeyRow): KeyView {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    masked_key: maskKey(row.api_key),
    status: (row.status as KeyStatus) ?? "active",
    usage_count: row.usage_count,
    success_count: row.success_count,
    fail_count: row.fail_count,
    last_used_at: row.last_used_at,
    last_checked_at: row.last_checked_at,
    last_error: row.last_error,
    created_at: row.created_at,
  };
}

export async function listKeys(): Promise<KeyRow[]> {
  await ensureSchema();
  const rs = await getTurso().execute(
    "SELECT * FROM api_keys ORDER BY created_at ASC, id ASC"
  );
  return rs.rows as unknown as KeyRow[];
}

export async function getKey(id: string): Promise<KeyRow | null> {
  await ensureSchema();
  const rs = await getTurso().execute({
    sql: "SELECT * FROM api_keys WHERE id = ?",
    args: [id],
  });
  return (rs.rows[0] as unknown as KeyRow) ?? null;
}

/** إضافة مفتاح مع رفض التكرار لنفس المزود (نفس القيمة الحرفية للمفتاح) */
export async function createKey(
  provider: ProviderId,
  apiKey: string,
  label = ""
): Promise<{ ok: true; row: KeyRow } | { ok: false; error: string }> {
  await ensureSchema();
  if (provider !== "kie" && provider !== "cometapi") {
    return { ok: false, error: "المزود غير مدعوم — المتاح: kie أو cometapi" };
  }
  if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length < 8) {
    return { ok: false, error: "المفتاح قصير جدًا أو غير صالح" };
  }
  const trimmed = apiKey.trim();
  const rs = await getTurso().execute({
    sql: "SELECT id FROM api_keys WHERE provider = ? AND api_key = ?",
    args: [provider, trimmed],
  });
  if (rs.rows.length > 0) {
    return { ok: false, error: "هذا المفتاح مضاف مسبقًا لنفس المزود — لا يمكن تكرار المفاتيح" };
  }
  const id = crypto.randomUUID();
  await getTurso().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)`,
    args: [id, provider, label.trim(), trimmed] satisfies InValue[],
  });
  const row = await getKey(id);
  return { ok: true, row: row! };
}

/** تعطيل/تنشيط يدوي أو حذف */
export async function setKeyStatus(
  id: string,
  status: "active" | "disabled"
): Promise<KeyRow | null> {
  await ensureSchema();
  await getTurso().execute({
    sql: "UPDATE api_keys SET status = ?, last_error = CASE WHEN ? = 'active' THEN NULL ELSE last_error END WHERE id = ?",
    args: [status, status, id] satisfies InValue[],
  });
  return getKey(id);
}

export async function deleteKey(id: string): Promise<boolean> {
  await ensureSchema();
  const rs = await getTurso().execute({
    sql: "DELETE FROM api_keys WHERE id = ?",
    args: [id],
  });
  return rs.rowsAffected > 0;
}

/**
 * حمولة المفاتيح المرشحة — الترتيب التسلسلي الصارم حسب ترتيب الإضافة.
 * المفتاح المستنزف (exhausted) يبقى في القائمة ولا يُستبعد؛ الاستثناء الوحيد التعطيل اليدوي (disabled).
 */
export async function getKeyPool(providers: string[]): Promise<KeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const rs = await getTurso().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers satisfies InValue[],
  });
  return rs.rows as unknown as KeyRow[];
}

/* ----------------------- تصنيف الأخطاء الموحّد (4.2) ----------------------- */

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

/** فئة الخطأ + رسالة داخلية موجزة */
export interface ProviderError {
  status: number;
  message: string;
  class: ErrorClass;
}

export class ProviderErrorImpl extends Error implements ProviderError {
  status: number;
  class: ErrorClass;
  constructor(status: number, message: string, cls: ErrorClass) {
    super(message);
    this.status = status;
    this.class = cls;
  }
}

const DISABLED_PATTERNS = /invalid api key|unauthorized|forbidden|authentication|invalid_key|api key not valid/i;
const EXHAUSTED_PATTERNS = /insufficient|quota|balance|credit|out of credits|exhausted|充值|no more credit|payment required|billing/i;

/**
 * تصنيف خطأ المزود حسب جدول 4.2:
 * - disabled: HTTP 401/403 أو رسائل رفض المفتاح → المفتاح disabled تلقائيًا ثم التالي
 * - exhausted: HTTP 402 أو رسائل نفاد الرصيد (تُفحص قبل 400 لأن بعض المزودين يرسلها بحالة 400)
 * - provider: موديل غير مدعوم (400/404/422 مع model not found / unsupported model)
 * - params: 400/422 معطيات الطلب → توقف فورًا (تبديل المفاتيح لا يحل خطأ معطيات)
 * - temporary: 429 و 5xx وأخطاء الشبكة/انتهاء المهلة → التالي الآن والمفتاح يبقى سليمًا
 */
export function classifyProviderError(status: number, message: string): ErrorClass {
  const msg = message || "";

  // نفاد الرصيد أولًا — بعض المزودين يرسلونه بحالة 400
  if (status === 402 || EXHAUSTED_PATTERNS.test(msg)) return "exhausted";

  if (status === 401 || status === 403 || DISABLED_PATTERNS.test(msg)) return "disabled";

  if (
    (status === 400 || status === 404 || status === 422) &&
    /model not found|unsupported model|unknown model|invalid model|model does not exist|no available model/i.test(msg)
  ) {
    return "provider";
  }

  if (status === 400 || status === 404 || status === 422) return "params";

  // 429 و 5xx وأي شيء آخر غير متوقع = مؤقت
  return "temporary";
}

/** تصنيف خطأ شبكة من طرفنا (timeout/abort/fetch) — دائمًا temporary */
export function networkError(message: string): ProviderErrorImpl {
  return new ProviderErrorImpl(0, message, "temporary");
}

/* --------------------- تحديث عدّادات وحالة المفاتيح --------------------- */

/**
 * تحديث المفتاح بعد كل محاولة (نجاح أو فشل):
 * - usage_count دائمًا؛ success/fail حسب النتيجة؛ last_used_at دائمًا
 * - الفئة disabled → تعليم المفتاح disabled تلقائيًا
 * - الفئة exhausted → تعليم المفتاح exhausted (يبقى في القاعدة)
 */
export async function recordKeyResult(
  keyId: string,
  ok: boolean,
  error?: { class: ErrorClass; message: string }
): Promise<void> {
  await ensureSchema();
  const sets: string[] = [
    "usage_count = usage_count + 1",
    "last_used_at = datetime('now')",
    "last_checked_at = datetime('now')",
  ];
  const args: InValue[] = [];
  if (ok) {
    sets.push("success_count = success_count + 1");
    sets.push("last_error = NULL");
    // نجاح المفتاح بعد استنفاد الرصيد (مثلًا بعد إعادة الشحن) يعيد حالته active تلقائيًا
    // (المفاتيح المعطّلة يدويًا لا تدخل الحمولة أصلًا فلن تصبح نشطة بهذا المسار)
    sets.push("status = CASE WHEN status != 'disabled' THEN 'active' ELSE status END");
  } else {
    sets.push("fail_count = fail_count + 1");
    sets.push("last_error = ?");
    args.push(error?.message?.slice(0, 500) ?? "خطأ غير معروف");
    if (error?.class === "disabled") {
      sets.push("status = 'disabled'");
    } else if (error?.class === "exhausted") {
      sets.push("status = 'exhausted'");
    }
  }
  args.push(keyId);
  await getTurso().execute({
    sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
}
