/**
 * أدوات مشتركة: الحدود، قراءة جسم الطلب، CORS، الاستجابات، المعرّفات
 */
const crypto = require("crypto");

function limits() {
  return {
    maxSources: Number(process.env.MAX_SOURCES || 10),
    sourceMaxMB: Number(process.env.SOURCE_MAX_MB || 200),
    outputMaxMB: Number(process.env.OUTPUT_MAX_MB || 150),
    maxTotalDurationSec: Number(process.env.MAX_TOTAL_DURATION_SEC || 600),
    uploadChunkBytes: 4 * 1024 * 1024, // حد حجم الطلب في Vercel ≈ 4.5MB → نرفع بأجزاء 4MB
    ffmpegPreset: process.env.FFMPEG_PRESET || "medium",
  };
}

/** قراءة جسم الطلب ثنائيًا مع حد أقصى */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (maxBytes && size > maxBytes) {
        reject(Object.assign(new Error("الطلب أكبر من الحد المسموح"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 2 * 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf-8"));
  } catch {
    const e = new Error("JSON تالف — تعذر تحليل جسم الطلب");
    e.status = 400;
    throw e;
  }
}

/** رابط الأساس المطلق من ترويسات الطلب (لروابط statusUrl/processUrl/الفيديو) */
function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function newJobId() {
  // معرّف قصير صديق للروابط مثل wkucdefoxwvd
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 11; i++) id += alphabet[crypto.randomInt(alphabet.length)];
  return id;
}

function formatBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

module.exports = { limits, readBody, readJson, baseUrl, sendJson, sendError, newJobId, formatBytes };
