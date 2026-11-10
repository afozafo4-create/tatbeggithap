/**
 * GET /api/tasks — أحدث المهام + إحصائيات للوحة العربية (تحديث تلقائي كل ~5 ثوانٍ)
 * تُستبعد روابط data: من القائمة لتفادي حمل ضخم على الواجهة
 */
import { NextRequest, NextResponse } from "next/server";
import { listRecentTasks, taskStats, parseTask, type TaskType, type TaskStatus } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const limit = Math.max(1, Math.min(100, Number(sp.get("limit") ?? 50)));
  const type = (sp.get("type") ?? undefined) as TaskType | undefined;
  const status = (sp.get("status") ?? undefined) as TaskStatus | undefined;

  const [rows, stats] = await Promise.all([
    listRecentTasks(limit, { type, status }),
    taskStats(),
  ]);

  const tasks = rows.map((row) => {
    const v = parseTask(row);
    // إخفاء data: URIs من الواجهة (بيانات مضمنة كبيرة) — نكتفي بالإشارة إلى وجودها
    const publicUrls = (v.result_urls ?? []).filter((u) => /^https?:\/\//i.test(u));
    const hasInlineData = (v.result_urls ?? []).some((u) => u.startsWith("data:"));
    return {
      id: v.id,
      provider: v.provider,
      model: v.model,
      type: v.type,
      status: v.status,
      progress: v.progress,
      prompt: v.prompt.slice(0, 120),
      result_urls: publicUrls,
      has_inline_data: hasInlineData,
      error_message: v.error_message,
      attempts: v.attempts,
      created_at: v.created_at,
      completed_at: v.completed_at,
    };
  });

  return NextResponse.json({ stats, tasks });
}
