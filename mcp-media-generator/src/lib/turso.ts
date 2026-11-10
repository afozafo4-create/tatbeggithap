/**
 * طبقة قاعدة البيانات (Turso / libSQL عبر HTTP — متوافقة مع Vercel serverless)
 * عميل واحد + ensureSchema تُنشئ الجداول عند أول وصول (لا حاجة لأداة migrations)
 */
import { createClient, type Client, type InValue } from "@libsql/client";

export type { InValue };

let client: Client | null = null;

/** عميل واحد مشترك — إعادة استخدامه يوفّر الاتصالات في بيئة الـ serverless */
export function getTurso(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url || !authToken) {
      throw new Error("متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة");
    }
    client = createClient({ url, authToken });
  }
  return client;
}

/** فحص صحة الاتصال: SELECT 1 */
export async function dbHealthy(): Promise<boolean> {
  try {
    const rs = await getTurso().execute("SELECT 1 AS one");
    return rs.rows[0]?.one === 1;
  } catch {
    return false;
  }
}

let schemaPromise: Promise<void> | null = null;

/** إنشاء الجداول عند أول وصول فقط (تُخزَّن النتيجة لتجنب التكرار في نفس العملية) */
export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getTurso();
      await db.execute(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        provider TEXT,
        provider_task_id TEXT,
        key_id TEXT,
        model TEXT NOT NULL,
        type TEXT NOT NULL,
        prompt TEXT DEFAULT '',
        params_json TEXT DEFAULT '{}',
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        result_urls_json TEXT,
        error_message TEXT,
        attempts_json TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT DEFAULT '',
        api_key TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        usage_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        last_used_at TEXT,
        last_checked_at TEXT,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`);
    })().catch((e) => {
      // فشل التهيئة لا يجب أن يُخزَّن مؤبدًا — المحاولة التالية تعيد الإنشاء
      schemaPromise = null;
      throw e;
    });
  }
  return schemaPromise;
}

/* ------------------------------ أنواع البيانات ------------------------------ */

export type TaskType = "image" | "video" | "merge";
export type TaskStatus = "pending" | "processing" | "completed" | "failed";

export interface AttemptEntry {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: TaskType;
  prompt: string;
  params_json: string;
  status: TaskStatus;
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/** تمثيل أبلغ للمهمة بعد تحويل أعمدة JSON إلى كائنات */
export interface TaskView extends Omit<TaskRow, "params_json" | "attempts_json" | "result_urls_json"> {
  params: Record<string, unknown>;
  attempts: AttemptEntry[];
  result_urls: string[] | null;
}

/** تحويل صف قاعدة البيانات إلى كائن مُحلَّل جاهز للاستخدام */
export function parseTask(row: TaskRow): TaskView {
  const urls: string[] | null = row.result_urls_json
    ? safeParse<string[]>(row.result_urls_json) ?? null
    : null;
  return {
    ...row,
    params: safeParse<Record<string, unknown>>(row.params_json) ?? {},
    attempts: safeParse<AttemptEntry[]>(row.attempts_json) ?? [],
    result_urls: urls,
  };
}

function safeParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/* ------------------------------ عمليات المهام ------------------------------ */

export interface InsertTaskInput {
  id: string;
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  model: string;
  type: TaskType;
  prompt?: string;
  params_json?: string;
  status?: TaskStatus;
  progress?: number;
}

export async function insertTask(input: InsertTaskInput): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.provider ?? null,
      input.provider_task_id ?? null,
      input.key_id ?? null,
      input.model,
      input.type,
      input.prompt ?? "",
      input.params_json ?? "{}",
      input.status ?? "processing",
      input.progress ?? 0,
    ] satisfies InValue[],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const rs = await getTurso().execute({
    sql: "SELECT * FROM tasks WHERE id = ?",
    args: [id],
  });
  if (rs.rows.length === 0) return null;
  return rs.rows[0] as unknown as TaskRow;
}

/** تحديث جزئي — يضيف المحاولات ويسجّل updated_at دائمًا، ويضبط completed_at تلقائيًا عند الاكتمال */
export async function updateTask(
  id: string,
  patch: {
    provider?: string | null;
    provider_task_id?: string | null;
    key_id?: string | null;
    status?: TaskStatus;
    progress?: number;
    result_urls_json?: string | null;
    error_message?: string | null;
    append_attempt?: AttemptEntry;
  }
): Promise<void> {
  const sets: string[] = ["updated_at = datetime('now')"];
  const args: InValue[] = [];

  if (patch.provider !== undefined) { sets.push("provider = ?"); args.push(patch.provider); }
  if (patch.provider_task_id !== undefined) { sets.push("provider_task_id = ?"); args.push(patch.provider_task_id); }
  if (patch.key_id !== undefined) { sets.push("key_id = ?"); args.push(patch.key_id); }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
    if (patch.status === "completed" || patch.status === "failed") {
      sets.push("completed_at = COALESCE(completed_at, datetime('now'))");
    }
    if (patch.status === "completed") {
      sets.push("progress = 100");
    }
  }
  if (patch.progress !== undefined) { sets.push("progress = ?"); args.push(Math.max(0, Math.min(100, Math.round(patch.progress)))); }
  if (patch.result_urls_json !== undefined) { sets.push("result_urls_json = ?"); args.push(patch.result_urls_json); }
  if (patch.error_message !== undefined) { sets.push("error_message = ?"); args.push(patch.error_message); }
  if (patch.append_attempt) {
    sets.push(
      `attempts_json = (
         SELECT COALESCE(json_group_array(json(value)), '[]') FROM (
           SELECT value FROM json_each(attempts_json) UNION ALL SELECT json(?)
         )
       )`
    );
    args.push(JSON.stringify(patch.append_attempt));
  }

  args.push(id);
  await getTurso().execute({
    sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
}

/** أحدث المهام حسب النوع والحالة اختياريًا — مرتبة من الأحدث */
export async function listRecentTasks(
  limit = 10,
  filter: { type?: TaskType; status?: TaskStatus } = {}
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filter.type) { where.push("type = ?"); args.push(filter.type); }
  if (filter.status) { where.push("status = ?"); args.push(filter.status); }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY created_at DESC, id DESC LIMIT ?`;
  args.push(limit);
  const rs = await getTurso().execute({ sql, args });
  return rs.rows as unknown as TaskRow[];
}

/** إحصائيات لوحة المهام: إجمالي/مكتملة/فاشلة/جارية */
export async function taskStats(): Promise<{
  total: number;
  completed: number;
  failed: number;
  active: number;
}> {
  await ensureSchema();
  const rs = await getTurso().execute(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS active
     FROM tasks`
  );
  const r = rs.rows[0] as unknown as Record<string, number | null>;
  return {
    total: r.total ?? 0,
    completed: r.completed ?? 0,
    failed: r.failed ?? 0,
    active: r.active ?? 0,
  };
}

/** توليد معرّف مهمة (task_id الذي يراه العميل) */
export function newTaskId(): string {
  return crypto.randomUUID();
}
