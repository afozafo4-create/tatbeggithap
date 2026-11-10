/**
 * خادم تطوير محلي يحاكي بيئة Vercel:
 * - يحمّل .env يدويًا
 * - يحلّل المسارات الديناميكية (/api/jobs/<id>/...) ويضعها في req.query مثل Vercel
 * - يخدم الواجهة الثابتة من public/ ويدعم CORS مفتوح
 * الاستخدام: node server.js  (الافتراضي http://localhost:3030)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

/* ------------------------------ تحميل .env يدويًا ------------------------------ */
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

/* --------------------------------- الموجهات --------------------------------- */
const jobsHandler = require("./api/jobs");
const jobIdHandler = require("./api/jobs/[id]");
const processHandler = require("./api/jobs/[id]/process");
const videoHandler = require("./api/jobs/[id]/video");
const uploadHandler = require("./api/upload");
const configHandler = require("./api/config");
const cronHandler = require("./api/cron");

function cors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

function serveStatic(res, file, contentType) {
  const p = path.join(__dirname, "public", file);
  if (!fs.existsSync(p)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType, "Content-Length": fs.statSync(p).size });
  fs.createReadStream(p).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (cors(req, res)) return;

    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    // المسارات الديناميكية تُوضع في req.query مثل بيئة Vercel
    req.query = Object.fromEntries(url.searchParams);

    if (p === "/" || p === "/index.html") {
      return serveStatic(res, "index.html", "text/html; charset=utf-8");
    }
    if (p === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }

    // /api/jobs/<id>/process | /api/jobs/<id>/video | /api/jobs/<id> | /api/jobs
    let m;
    if ((m = p.match(/^\/api\/jobs\/([^/]+)\/process$/))) {
      req.query.id = decodeURIComponent(m[1]);
      return await processHandler(req, res);
    }
    if ((m = p.match(/^\/api\/jobs\/([^/]+)\/video$/))) {
      req.query.id = decodeURIComponent(m[1]);
      return await videoHandler(req, res);
    }
    if ((m = p.match(/^\/api\/jobs\/([^/]+)$/))) {
      req.query.id = decodeURIComponent(m[1]);
      return await jobIdHandler(req, res);
    }
    if (p === "/api/jobs") return await jobsHandler(req, res);
    if (p === "/api/upload") return await uploadHandler(req, res);
    if (p === "/api/config") return await configHandler(req, res);
    if (p === "/api/cron") return await cronHandler(req, res);

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "المسار غير موجود" }));
  } catch (e) {
    console.error("خطأ غير متوقع:", e);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ error: "خطأ داخلي في الخادم" }));
  }
});

const PORT = Number(process.env.PORT || 3030);
server.listen(PORT, () => {
  console.log(`خدمة دمج الفيديوهات تعمل محليًا على: http://localhost:${PORT}`);
  console.log(`فحص الجهوزية: curl http://localhost:${PORT}/api/config`);
});
