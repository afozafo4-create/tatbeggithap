/**
 * GET  /api/keys — القائمة كاملة مع إخفاء المفاتيح دائمًا (maskKey)
 * POST /api/keys — {provider, api_key, label?} مع رفض التكرار لنفس المزود
 */
import { NextRequest, NextResponse } from "next/server";
import { listKeys, createKey, toKeyView } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await listKeys();
  return NextResponse.json({ keys: rows.map(toKeyView) });
}

export async function POST(req: NextRequest) {
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "جسم الطلب يجب أن يكون JSON صالحًا" }, { status: 400 });
  }
  if (!body.provider || !body.api_key) {
    return NextResponse.json({ error: "المزود (provider) والمفتاح (api_key) مطلوبان" }, { status: 400 });
  }
  if (body.provider !== "kie" && body.provider !== "cometapi") {
    return NextResponse.json({ error: "المزود غير مدعوم — المتاح: kie أو cometapi" }, { status: 400 });
  }
  const result = await createKey(body.provider, body.api_key, body.label ?? "");
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 409 });
  }
  return NextResponse.json({ key: toKeyView(result.row) }, { status: 201 });
}
