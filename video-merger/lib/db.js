/**
 * طبقة قاعدة البيانات — Turso (libSQL) عبر @libsql/client
 * كل شيء يُخزَّن هنا: بيانات المهام، أجزاء ملفات المصادر، والفيديو الناتج (Blobs)
 * لا S3 ولا خدمات خارجية إطلاقًا.
 */
const { createClient } = require("@libsql/client");

let client = null;

function db() {
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

let schemaPromise = null;

/** إنشاء الجداول عند أول وصول — مفاتيح أساسية مركّبة */
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const c = db();
      await c.execute(`CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'queued',
        progress INTEGER DEFAULT 0,
        error TEXT,
        output_size INTEGER,
        output_duration REAL,
        output_resolution TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT
      )`);
      await c.execute(`CREATE TABLE IF NOT EXISTS sources (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        url TEXT,
        name TEXT,
        size INTEGER,
        mime TEXT,
        received INTEGER DEFAULT 0,
        PRIMARY KEY (job_id, seq)
      )`);
      // كل Blob يُقسَّم إلى صفوف 2MB (حد HTTP في Turso)
      await c.execute(`CREATE TABLE IF NOT EXISTS source_chunks (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        chunk INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (job_id, seq, chunk)
      )`);
      await c.execute(`CREATE TABLE IF NOT EXISTS output_chunks (
        job_id TEXT NOT NULL,
        chunk INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (job_id, chunk)
      )`);
    })().catch((e) => {
      schemaPromise = null;
      throw e;
    });
  }
  return schemaPromise;
}

/* ------------------------------- عمليات المهام ------------------------------- */

async function insertJob(id, status) {
  await ensureSchema();
  // expires_at = created_at + 24 ساعة — التنظيف كسول عند كل طلب إنشاء/دمج + cron يومي
  await db().execute({
    sql: `INSERT INTO jobs (id, status, expires_at)
          VALUES (?, ?, datetime('now', '+24 hours'))`,
    args: [id, status],
  });
}

async function getJob(id) {
  await ensureSchema();
  const rs = await db().execute({ sql: "SELECT * FROM jobs WHERE id = ?", args: [id] });
  return rs.rows[0] || null;
}

async function updateJob(id, patch) {
  const sets = [];
  const args = [];
  for (const key of ["status", "progress", "error", "output_size", "output_duration", "output_resolution"]) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      args.push(patch[key]);
    }
  }
  if (!sets.length) return;
  args.push(id);
  await db().execute({ sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args });
}

async function listJobs(limit = 50) {
  await ensureSchema();
  const rs = await db().execute({
    sql: "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?",
    args: [limit],
  });
  return rs.rows;
}

/** حذف شامل: كل صفوف المهمة في batch واحد (jobs + sources + source_chunks + output_chunks) */
async function deleteJob(id) {
  await ensureSchema();
  await db().batch(
    [
      { sql: "DELETE FROM jobs WHERE id = ?", args: [id] },
      { sql: "DELETE FROM sources WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [id] },
    ],
    "write"
  );
}

/** حذف أجزاء المصادر فقط بعد نجاح الدمج — الناتج فقط هو المطلوب */
async function deleteSourceChunks(jobId) {
  await db().execute({ sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] });
}

/** حذف كل المهام المنتهية الصلاحية (24 ساعة) — يُستدعى كسولًا ومن /api/cron */
async function deleteExpiredJobs() {
  await ensureSchema();
  const rs = await db().execute("SELECT id FROM jobs WHERE expires_at < datetime('now')");
  for (const row of rs.rows) {
    await deleteJob(row.id);
  }
  return rs.rows.length;
}

/* --------------------------------- المصادر --------------------------------- */

async function insertSource(jobId, seq, src) {
  await db().execute({
    sql: `INSERT INTO sources (job_id, seq, kind, url, name, size, mime, received)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [jobId, seq, src.kind, src.url || null, src.name || null, src.size || 0, src.mime || null, src.received || 0],
  });
}

async function listSources(jobId) {
  const rs = await db().execute({
    sql: "SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC",
    args: [jobId],
  });
  return rs.rows;
}

async function updateSourceReceived(jobId, seq, received) {
  await db().execute({
    sql: "UPDATE sources SET received = ? WHERE job_id = ? AND seq = ?",
    args: [received, jobId, seq],
  });
}

/* ------------------------------ تخزين الـ Blobs ------------------------------ */

const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB لكل صف (حد HTTP في Turso)

/** تقسيم Buffer إلى صفوف 2MB في جدول الأجزاء */
async function writeBlob(table, jobId, seq, buffer) {
  const chunks = Math.ceil(buffer.length / CHUNK_SIZE);
  const statements = [];
  for (let i = 0; i < chunks; i++) {
    const part = buffer.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    if (table === "output_chunks") {
      statements.push({ sql: "INSERT INTO output_chunks (job_id, chunk, data) VALUES (?, ?, ?)", args: [jobId, i, part] });
    } else {
      statements.push({ sql: "INSERT INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)", args: [jobId, seq, i, part] });
    }
  }
  if (statements.length) await db().batch(statements, "write");
}

/** استبدال الناتج القديم (حذف ثم كتابة) */
async function saveOutput(jobId, buffer) {
  await db().execute({ sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [jobId] });
  await writeBlob("output_chunks", jobId, 0, buffer);
}

/** إلحاق جزء مرفوع (chunk index معروف من الاستعلام) */
async function putSourceChunk(jobId, seq, chunkIndex, buffer) {
  await db().execute({
    sql: `INSERT INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)
          ON CONFLICT (job_id, seq, chunk) DO UPDATE SET data = excluded.data`,
    args: [jobId, seq, chunkIndex, buffer],
  });
}

/** حجم المخزَّن بالبايت لجزء معين */
async function blobSize(table, jobId, seq) {
  const sql =
    table === "output"
      ? "SELECT COALESCE(SUM(length(data)), 0) AS n FROM output_chunks WHERE job_id = ?"
      : "SELECT COALESCE(SUM(length(data)), 0) AS n FROM source_chunks WHERE job_id = ? AND seq = ?";
  const args = table === "output" ? [jobId] : [jobId, seq];
  const rs = await db().execute({ sql, args });
  return Number(rs.rows[0]?.n ?? 0);
}

/** صفحات من 8 صفوف — يعيد الصفوف التالية بعد آخرChunk المُستهلَم */
async function readBlobRows(table, jobId, seq, afterChunk, pageSize = 8) {
  const sql =
    table === "output"
      ? "SELECT chunk, data FROM output_chunks WHERE job_id = ? AND chunk > ? ORDER BY chunk ASC LIMIT ?"
      : "SELECT chunk, data FROM source_chunks WHERE job_id = ? AND seq = ? AND chunk > ? ORDER BY chunk ASC LIMIT ?";
  const args =
    table === "output" ? [jobId, afterChunk, pageSize] : [jobId, seq, afterChunk, pageSize];
  const rs = await db().execute({ sql, args });
  return rs.rows.map((r) => ({ chunk: Number(r.chunk), data: r.data }));
}

module.exports = {
  db,
  ensureSchema,
  insertJob,
  getJob,
  updateJob,
  listJobs,
  deleteJob,
  deleteSourceChunks,
  deleteExpiredJobs,
  insertSource,
  listSources,
  updateSourceReceived,
  saveOutput,
  putSourceChunk,
  blobSize,
  readBlobRows,
  CHUNK_SIZE,
};
