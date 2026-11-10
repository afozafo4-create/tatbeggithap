/**
 * خادم MCP على المسار /mcp — نقل Streamable HTTP حسب مواصفات MCP
 * SDK رسمي: McpServer + WebStandardStreamableHTTPServerTransport (لا JSON-RPC يدوي)
 * POST لرسائل JSON-RPC، GET لتيار SSE، DELETE لإنهاء الجلسة.
 * إذا ضُبط MCP_ACCESS_TOKEN فيُطلب Authorization: Bearer <token> على كل الطرق.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification, ServerResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runGeneration, refreshTask, type ProgressNotifier } from "@/lib/generation";
import { runMerge, type MergeInput } from "@/lib/merger";
import { listRecentTasks, parseTask, type TaskType, type TaskStatus } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

/** نص التعليمات الجاهز المُرسل مع initialize (حرفيًا كما في المواصفة) */
export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

/* ------------------------- إدارة الجلسات في الذاكرة ------------------------- */

interface SessionEntry {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
}
const sessions = new Map<string, SessionEntry>();

/* --------------------------- صياغة الردود العربية --------------------------- */

function formatLinks(urls: string[]): string {
  return urls.map((u) => `- ${u}`).join("\n");
}

const TYPE_AR: Record<TaskType, string> = { image: "صورة", video: "فيديو", merge: "دمج مقاطع" };
const STATUS_AR: Record<TaskStatus, string> = {
  pending: "بانتظار",
  processing: "قيد المعالجة",
  completed: "مكتملة",
  failed: "فاشلة",
};

/* ------------------------------ بناء الخادم ------------------------------ */

function createServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  const makeNotify = (
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>
  ): ProgressNotifier | undefined => {
    const token = extra._meta?.progressToken;
    if (token === undefined || token === null) return undefined;
    return (progress, total, message) => {
      void extra
        .sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress, total, message },
        })
        .catch(() => {});
    };
  };

  /* 1) generate_image */
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image or nano-banana-pro (automatic failover across all active API keys). Returns the ready image URL if completed within the wait window; otherwise returns a task_id — call get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image", "nano-banana-pro"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      const notify = makeNotify(extra);
      const outcome = await runGeneration(args, notify);
      switch (outcome.status) {
        case "completed":
          return { content: [{ type: "text", text: `✅ تم توليد الصورة بنجاح\n\n![image](${outcome.urls[0]})\n\nالرابط المباشر: ${outcome.urls[0]}` }] };
        case "processing":
          return {
            content: [{ type: "text", text: `⏳ المهمة قيد المعالجة — task_id: ${outcome.taskId}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.` }],
          };
        case "failed":
          return { isError: true, content: [{ type: "text", text: `❌ فشلت المهمة: ${outcome.reason}` }] };
        case "no_keys":
          return {
            isError: true,
            content: [{ type: "text", text: `❌ لا توجد مفاتيح نشطة لخدمة ${outcome.model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.` }],
          };
      }
    }
  );

  /* 2) generate_video */
  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio, optional image-to-video). Videos take minutes: a short wait streams progress, then a task_id is returned — track it with get_task every ~10 seconds.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      const notify = makeNotify(extra);
      const outcome = await runGeneration(args, notify);
      switch (outcome.status) {
        case "completed":
          return { content: [{ type: "text", text: `✅ تم توليد الفيديو بنجاح\n\n${formatLinks(outcome.urls)}` }] };
        case "processing":
          return {
            content: [{ type: "text", text: `⏳ المهمة قيد المعالجة — task_id: ${outcome.taskId}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.` }],
          };
        case "failed":
          return { isError: true, content: [{ type: "text", text: `❌ فشلت المهمة: ${outcome.reason}` }] };
        case "no_keys":
          return {
            isError: true,
            content: [{ type: "text", text: `❌ لا توجد مفاتيح نشطة لخدمة ${outcome.model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.` }],
          };
      }
    }
  );

  /* 3) merge_videos */
  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Merge several clips into one final video in the given order. Pass urls (public direct video links — e.g. links from generate_video) or task_ids (completed video tasks; their URLs are resolved from the database in this order — ideal after generating several clips). Merging is usually fast: a short wait streams progress, then a merge task_id is returned — track it with get_task. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        // الحدود الفعلية (≥2 و ≤10) تُفحص في validateMergeInput لتُعاد رسائل عربية واضحة بدل خطأ مخطط بروتوكولي
        urls: z
          .array(z.string())
          .optional()
          .describe("Public direct video URLs (http/https) in merge order — 2 to 10 links; the first clip starts the final video."),
        task_ids: z
          .array(z.string())
          .optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks (2 to 10) — their result URLs are merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      const notify = makeNotify(extra);
      if (!args.urls?.length && !args.task_ids?.length) {
        return {
          isError: true,
          content: [{ type: "text", text: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." }],
        };
      }
      const outcome = await runMerge(args as MergeInput, notify);
      if (outcome.status === "invalid") {
        return { isError: true, content: [{ type: "text", text: outcome.reason }] };
      }
      if (outcome.status === "completed") {
        return {
          content: [{
            type: "text",
            text: `✅ تم دمج المقاطع بنجاح\n\n${formatLinks(outcome.urls)}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`,
          }],
        };
      }
      if (outcome.status === "failed") {
        return { isError: true, content: [{ type: "text", text: `❌ فشلت المهمة: ${outcome.reason}` }] };
      }
      return {
        content: [{ type: "text", text: `⏳ المهمة قيد المعالجة — task_id: ${outcome.taskId}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.` }],
      };
    }
  );

  /* 4) get_task */
  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Track any task by its ID — image/video generation and merging (reads the Turso database and live-updates from the provider/merging service while running). Poll it every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().min(1),
      },
    },
    async (args) => {
      const outcome = await refreshTask(args.task_id);
      if (outcome.status === "not_found") {
        return {
          isError: true,
          content: [{ type: "text", text: `❌ المهمة غير موجودة: ${args.task_id}` }],
        };
      }
      const v = outcome.task;
      const urls = (v.result_urls ?? []).filter((u) => !u.startsWith("data:"));
      if (v.status === "completed") {
        if (v.type === "image") {
          const url = urls[0] ?? "";
          return { content: [{ type: "text", text: `✅ تم توليد الصورة بنجاح\n\n![image](${url})\n\nالرابط المباشر: ${url}` }] };
        }
        if (v.type === "video") {
          return { content: [{ type: "text", text: `✅ تم توليد الفيديو بنجاح\n\n${formatLinks(urls)}` }] };
        }
        // merge — ملاحظة الـ 24 ساعة إلزامية
        return {
          content: [{
            type: "text",
            text: `✅ تم دمج المقاطع بنجاح\n\n${formatLinks(urls)}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`,
          }],
        };
      }
      if (v.status === "failed") {
        return { isError: true, content: [{ type: "text", text: `❌ فشلت المهمة: ${v.error_message ?? "سبب غير معروف"}` }] };
      }
      return {
        content: [{
          type: "text",
          text: `⏳ المهمة قيد المعالجة — task_id: ${v.id}\nالتقدم الحالي: ${v.progress}%\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
        }],
      };
    }
  );

  /* 5) list_media */
  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "List the latest images/videos/merges stored with their URLs from the database (no regeneration) — to recall previous results.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const rows = await listRecentTasks(args.limit, {
        type: args.type as TaskType | undefined,
        status: args.status as TaskStatus | undefined,
      });
      if (rows.length === 0) {
        return { content: [{ type: "text", text: "لا توجد مهام مخزنة بعد — ابدأ بـ generate_image أو generate_video." }] };
      }
      const lines = rows.map((row) => {
        const v = parseTask(row);
        const urls = (v.result_urls ?? []).filter((u) => !u.startsWith("data:"));
        const links = urls.length ? `\n  الروابط: ${urls.join(" ، ")}` : "";
        return `- [${TYPE_AR[v.type]}] ${v.model} — ${STATUS_AR[v.status]} (${v.progress}%) — task_id: ${v.id}${links}`;
      });
      return { content: [{ type: "text", text: `أحدث الوسائط المخزنة (${rows.length}):\n\n${lines.join("\n")}` }] };
    }
  );

  return server;
}

/* --------------------------- حماية المسار (اختياري) --------------------------- */

function authOk(req: Request): boolean {
  const expected = process.env.MCP_ACCESS_TOKEN;
  if (!expected) return true; // بدون توكن — الوصول مفتوح
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${expected}`;
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/* ------------------------------ Route handlers ------------------------------ */

export async function POST(req: Request): Promise<Response> {
  if (!authOk(req)) return jsonError(401, "Unauthorized: MCP access token missing or invalid");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "Parse error: invalid JSON body");
  }

  const sessionId = req.headers.get("mcp-session-id");
  let entry: SessionEntry | undefined = sessionId ? sessions.get(sessionId) : undefined;

  if (!entry) {
    // جلسة جديدة (initialize) — أنشئ نقلًا وخادمًا جديدين واربطهما
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, entry!);
      },
    });
    const server = createServer();
    entry = { transport, server };
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
      void server.close().catch(() => {});
    };
    await server.connect(transport);
  }

  try {
    return await entry.transport.handleRequest(req, { parsedBody: body as never });
  } catch (e) {
    return jsonError(500, `Internal error: ${(e as Error).message}`);
  }
}

export async function GET(req: Request): Promise<Response> {
  if (!authOk(req)) return jsonError(401, "Unauthorized: MCP access token missing or invalid");
  const sessionId = req.headers.get("mcp-session-id");
  const entry = sessionId ? sessions.get(sessionId) : undefined;
  if (!entry) {
    return new Response("Method Not Allowed: no valid session — initialize first via POST", { status: 405 });
  }
  try {
    return await entry.transport.handleRequest(req);
  } catch (e) {
    return jsonError(500, `Internal error: ${(e as Error).message}`);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  if (!authOk(req)) return jsonError(401, "Unauthorized: MCP access token missing or invalid");
  const sessionId = req.headers.get("mcp-session-id");
  const entry = sessionId ? sessions.get(sessionId) : undefined;
  if (!entry) {
    return jsonError(404, "Session not found");
  }
  try {
    return await entry.transport.handleRequest(req);
  } catch (e) {
    return jsonError(500, `Internal error: ${(e as Error).message}`);
  }
}
