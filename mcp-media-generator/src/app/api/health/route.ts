/**
 * GET /api/health — فحص الجهوزية الشامل
 * database: turso-connected عبر SELECT 1
 * merger.healthy: فحص GET {MERGER_API_BASE}/api/config بمهلة 4 ثوانٍ
 */
import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { mergerHealthy, mergerBase } from "@/lib/merger";
import { getModels } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [dbOk, mergerOk] = await Promise.all([dbHealthy(), mergerHealthy()]);
  return NextResponse.json({
    ok: dbOk,
    database: dbOk ? "turso-connected" : "turso-unreachable",
    mcpEndpoint: "/mcp",
    models: getModels().map((m) => ({
      canonical: m.canonical,
      type: m.type,
      providers: m.providers,
    })),
    merger: {
      base: mergerBase() || "(غير مضبوط)",
      healthy: mergerOk,
    },
    authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
  });
}
