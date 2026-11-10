/**
 * PATCH  /api/keys/{id} — تعطيل/تنشيط يدوي {action: "disable"|"enable"} أو {status: "disabled"|"active"}
 * DELETE /api/keys/{id} — حذف نهائي
 */
import { NextRequest, NextResponse } from "next/server";
import { getKey, setKeyStatus, deleteKey, toKeyView } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: { status?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "جسم الطلب يجب أن يكون JSON صالحًا" }, { status: 400 });
  }
  const wantDisabled = body.status === "disabled" || body.action === "disable";
  const wantActive = body.status === "active" || body.action === "enable";
  if (!wantDisabled && !wantActive) {
    return NextResponse.json({ error: "أرسل {action: \"disable\"|\"enable\"} أو {status: \"disabled\"|\"active\"}" }, { status: 400 });
  }
  const row = await setKeyStatus(id, wantDisabled ? "disabled" : "active");
  if (!row) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  return NextResponse.json({ key: toKeyView(row) });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ok = await deleteKey(id);
  if (!ok) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/** GET فردي — مفيد للتشخيص (يعيد المفتاح مُقنَّعًا دائمًا) */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const row = await getKey(id);
  if (!row) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  return NextResponse.json({ key: toKeyView(row) });
}
