"use client";

/**
 * لوحة الإدارة العربية (RTL) — صفحة واحدة فيها:
 * هيدر بحالة /api/health + ثلاث بطاقات: مدير المفاتيح، لوحة المهام، ربط السيرفر
 * التحديث التلقائي: المهام كل ~5 ثوانٍ، الصحة كل ~15 ثانية
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Copy,
  Database,
  KeyRound,
  Link2,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";

/* --------------------------------- الأنواع --------------------------------- */

interface KeyView {
  id: string;
  provider: string;
  label: string;
  masked_key: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface TaskItem {
  id: string;
  provider: string | null;
  model: string;
  type: "image" | "video" | "merge";
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  prompt: string;
  result_urls: string[];
  has_inline_data: boolean;
  error_message: string | null;
  attempts: Array<{ provider: string; keyLabel: string; ok: boolean; errorClass?: string; error?: string; at: string }>;
  created_at: string;
}

interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: Array<{ canonical: string; type: string; providers: string[] }>;
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

const PROVIDER_LABEL: Record<string, string> = { kie: "kie.ai", cometapi: "CometAPI" };
const TYPE_AR: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const STATUS_AR: Record<string, string> = { pending: "بانتظار", processing: "قيد المعالجة", completed: "مكتملة", failed: "فاشلة" };

const TOOL_CHIPS: Array<{ name: string; desc: string }> = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي وإعادة الرابط جاهزًا" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي (image-to-video اختياري)" },
  { name: "merge_videos", desc: "دمج عدة مقاطع في مقطع واحد بالترتيب المطلوب" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها وتحديثها حية من المزود" },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المخزنة بروابطها" },
];

/* --------------------------------- المكونات --------------------------------- */

function statusBadge(status: string) {
  switch (status) {
    case "active":
      return <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30">نشط</Badge>;
    case "exhausted":
      return <Badge className="bg-amber-500/15 text-amber-300 border-amber-500/30">مستنزف</Badge>;
    case "disabled":
      return <Badge className="bg-zinc-500/15 text-zinc-400 border-zinc-500/30">معطَّل</Badge>;
    case "completed":
      return <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30">مكتملة</Badge>;
    case "failed":
      return <Badge className="bg-rose-500/15 text-rose-300 border-rose-500/30">فاشلة</Badge>;
    case "processing":
    case "pending":
      return <Badge className="bg-cyan-500/15 text-cyan-300 border-cyan-500/30">{STATUS_AR[status]}</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}

export default function Dashboard() {
  const { toast } = useToast();
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, active: 0 });
  const [origin, setOrigin] = useState("");

  // نموذج إضافة مفتاح
  const [provider, setProvider] = useState<"kie" | "cometapi">("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [adding, setAdding] = useState(false);

  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const [tRes, kRes] = await Promise.all([
        fetch("/api/tasks?limit=25", { cache: "no-store" }),
        fetch("/api/keys", { cache: "no-store" }),
      ]);
      if (tRes.ok) {
        const t = await tRes.json();
        setTasks(t.tasks ?? []);
        setStats(t.stats ?? stats);
      }
      if (kRes.ok) {
        const k = await kRes.json();
        setKeys(k.keys ?? []);
      }
    } catch {
      // تجاهل أخطاء التحديث المؤقتة — الدورة القادمة تعيد المحاولة
    } finally {
      busy.current = false;
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (res.ok) setHealth(await res.json());
    } catch {
      setHealth((h) => (h ? { ...h, ok: false } : h));
    }
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    refresh();
    refreshHealth();
    const t1 = setInterval(refresh, 5000); // المهام كل ~5 ثوانٍ
    const t2 = setInterval(refreshHealth, 15000); // الصحة كل ~15 ثانية
    return () => {
      clearInterval(t1);
      clearInterval(t2);
    };
  }, [refresh, refreshHealth]);

  const copy = useCallback(
    async (text: string, what: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast({ description: `تم نسخ ${what} إلى الحافظة ✓` });
      } catch {
        toast({ description: "تعذّر النسخ — انسخ النص يدويًا", variant: "destructive" });
      }
    },
    [toast]
  );

  const addKey = async () => {
    if (!apiKey.trim()) {
      toast({ description: "أدخل المفتاح أولًا", variant: "destructive" });
      return;
    }
    setAdding(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const body = await res.json();
      if (!res.ok) {
        toast({ description: body.error ?? "فشل إضافة المفتاح", variant: "destructive" });
      } else {
        toast({ description: "تمت إضافة المفتاح بنجاح ✓" });
        setApiKey("");
        setLabel("");
        refresh();
      }
    } catch {
      toast({ description: "خطأ شبكة — أعد المحاولة", variant: "destructive" });
    } finally {
      setAdding(false);
    }
  };

  const toggleKey = async (k: KeyView) => {
    const action = k.status === "disabled" ? "enable" : "disable";
    const res = await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (res.ok) {
      toast({ description: action === "disable" ? "تم تعطيل المفتاح" : "تم تنشيط المفتاح" });
      refresh();
    } else {
      const b = await res.json().catch(() => ({}));
      toast({ description: b.error ?? "فشل التعديل", variant: "destructive" });
    }
  };

  const removeKey = async (k: KeyView) => {
    const res = await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    if (res.ok) {
      toast({ description: "تم حذف المفتاح" });
      refresh();
    } else {
      const b = await res.json().catch(() => ({}));
      toast({ description: b.error ?? "فشل الحذف", variant: "destructive" });
    }
  };

  /* -------------------------- نصوص ربط السيرفر -------------------------- */

  const mcpUrl = origin ? `${origin}/mcp` : "";
  const authHeader = health?.authRequired ? `\n      "headers": { "Authorization": "Bearer <MCP_ACCESS_TOKEN>" }` : "";

  const chatgptJson = useMemo(
    () =>
      health?.authRequired
        ? JSON.stringify(
            { mcpServers: { "media-generator": { url: mcpUrl || "<MCP_URL>", headers: { Authorization: "Bearer <MCP_ACCESS_TOKEN>" } } } },
            null,
            2
          )
        : JSON.stringify({ mcpServers: { "media-generator": { url: mcpUrl || "<MCP_URL>" } } }, null, 2),
    [mcpUrl, health?.authRequired]
  );

  const claudeJson = useMemo(
    () =>
      health?.authRequired
        ? JSON.stringify(
            { mcpServers: { "media-generator": { type: "http", url: mcpUrl || "<MCP_URL>", headers: { Authorization: "Bearer <MCP_ACCESS_TOKEN>" } } } },
            null,
            2
          )
        : JSON.stringify({ mcpServers: { "media-generator": { type: "http", url: mcpUrl || "<MCP_URL>" } } }, null, 2),
    [mcpUrl, health?.authRequired]
  );

  const cursorJson = chatgptJson;

  return (
    <div className="min-h-screen flex flex-col bg-[#0a0e1a] text-zinc-100" dir="rtl">
      {/* خلفية متدرجة سماوي/بنفسجي خفيفة */}
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,rgba(34,211,238,0.08),transparent_55%),radial-gradient(ellipse_at_bottom_left,rgba(139,92,246,0.07),transparent_50%)]" />

      {/* الهيدر */}
      <header className="relative border-b border-white/10 bg-white/[0.03] backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 py-4 flex flex-wrap items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500 to-violet-600 shadow-lg shadow-cyan-500/20">
            <Activity className="h-5 w-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold leading-tight">مولّد الوسائط — خادم MCP</h1>
            <p className="text-xs text-zinc-400">توليد الصور والفيديو ودمج المقاطع عبر kie.ai و CometAPI</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {health?.authRequired && <Badge variant="outline" className="border-cyan-500/40 text-cyan-300">محمي بـ Token</Badge>}
            {health ? (
              health.ok ? (
                <Badge className="gap-1.5 bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  <Database className="h-3.5 w-3.5" /> Turso متصل
                </Badge>
              ) : (
                <Badge className="gap-1.5 bg-rose-500/15 text-rose-300 border border-rose-500/30">
                  <Database className="h-3.5 w-3.5" /> غير متصل
                </Badge>
              )
            ) : (
              <Badge className="gap-1.5 bg-zinc-500/15 text-zinc-400 border border-zinc-500/30">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> جارٍ الفحص…
              </Badge>
            )}
            {health?.merger && (
              <Badge
                className={
                  health.merger.healthy
                    ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                    : "bg-amber-500/15 text-amber-300 border border-amber-500/30"
                }
              >
                خدمة الدمج: {health.merger.healthy ? "جاهزة" : "غير متاحة"}
              </Badge>
            )}
          </div>
        </div>
      </header>

      {/* المحتوى */}
      <main className="relative mx-auto w-full max-w-6xl flex-1 px-4 py-6 grid gap-6 lg:grid-cols-2">
        {/* أ) مدير المفاتيح */}
        <Card className="border-white/10 bg-white/[0.04] backdrop-blur">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4.5 w-4.5 text-cyan-400" />
              مدير المفاتيح
            </CardTitle>
            <p className="text-xs leading-5 text-amber-300/90 bg-amber-500/10 border border-amber-500/25 rounded-md p-2">
              أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد
              رصيد دون توقف.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* نموذج الإضافة */}
            <div className="grid gap-2 sm:grid-cols-[130px_1fr]">
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as "kie" | "cometapi")}
                className="h-9 rounded-md border border-white/15 bg-white/5 px-2 text-sm text-zinc-100"
                aria-label="المزود"
              >
                <option value="kie">kie.ai</option>
                <option value="cometapi">CometAPI</option>
              </select>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="تسمية اختيارية (مثال: حساب رئيسي)"
                className="border-white/15 bg-white/5 text-zinc-100 placeholder:text-zinc-500"
              />
            </div>
            <div className="flex gap-2">
              <Input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="الصق مفتاح API هنا"
                type="password"
                dir="ltr"
                className="flex-1 border-white/15 bg-white/5 font-mono text-xs text-zinc-100 placeholder:text-zinc-500"
                onKeyDown={(e) => e.key === "Enter" && addKey()}
              />
              <Button onClick={addKey} disabled={adding} className="gap-1.5 bg-gradient-to-l from-cyan-500 to-violet-600 hover:opacity-90">
                {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                إضافة
              </Button>
            </div>

            {/* قائمة المفاتيح */}
            <div className="max-h-96 overflow-y-auto space-y-2 rounded-lg p-1" style={{ scrollbarWidth: "thin" }}>
              {keys.length === 0 && (
                <p className="text-center text-sm text-zinc-500 py-6">لا توجد مفاتيح بعد — أضف أول مفتاح لتبدأ التوليد.</p>
              )}
              {keys.map((k) => (
                <div key={k.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="border-white/20 text-zinc-300">{PROVIDER_LABEL[k.provider] ?? k.provider}</Badge>
                      <span dir="ltr" className="font-mono text-xs text-zinc-300">{k.masked_key}</span>
                      {k.label && <span className="text-xs text-zinc-400">({k.label})</span>}
                      {statusBadge(k.status)}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" variant="outline" onClick={() => toggleKey(k)} className="h-7 border-white/15 text-xs text-zinc-300 hover:bg-white/10">
                        {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => removeKey(k)} className="h-7 border-rose-500/30 text-rose-300 hover:bg-rose-500/10">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap text-[11px] text-zinc-400" dir="rtl">
                    <span>استخدام: <b className="text-zinc-200">{k.usage_count}</b></span>
                    <span className="text-emerald-400">نجاح: <b>{k.success_count}</b></span>
                    <span className="text-rose-400">فشل: <b>{k.fail_count}</b></span>
                    {k.last_used_at && <span>آخر استخدام: {new Date(k.last_used_at + "Z").toLocaleString("ar", { hour12: false })}</span>}
                  </div>
                  {k.last_error && (
                    <p className="text-[11px] text-rose-300/80 truncate" title={k.last_error}>آخر خطأ: {k.last_error}</p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* ب) لوحة المهام */}
        <Card className="border-white/10 bg-white/[0.04] backdrop-blur">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-base">
              <span className="flex items-center gap-2">
                <Activity className="h-4.5 w-4.5 text-violet-400" />
                لوحة المهام
              </span>
              <RefreshCw className="h-4 w-4 text-zinc-500" />
            </CardTitle>
            {/* شرائح الإحصائيات */}
            <div className="grid grid-cols-4 gap-2 pt-1">
              {[
                { label: "الإجمالي", value: stats.total, cls: "text-zinc-100 border-white/15" },
                { label: "مكتملة", value: stats.completed, cls: "text-emerald-300 border-emerald-500/30" },
                { label: "فاشلة", value: stats.failed, cls: "text-rose-300 border-rose-500/30" },
                { label: "جارية", value: stats.active, cls: "text-cyan-300 border-cyan-500/30" },
              ].map((s) => (
                <div key={s.label} className={`rounded-lg border bg-white/[0.03] px-2 py-2 text-center ${s.cls}`}>
                  <div className="text-lg font-bold leading-none">{s.value}</div>
                  <div className="text-[10px] mt-1 opacity-80">{s.label}</div>
                </div>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            <div className="max-h-[420px] overflow-y-auto space-y-2 rounded-lg p-1" style={{ scrollbarWidth: "thin" }}>
              {tasks.length === 0 && (
                <p className="text-center text-sm text-zinc-500 py-8">لا توجد مهام بعد — ابدأ من عميل MCP (ChatGPT / Claude / Cursor) بالأداة generate_image.</p>
              )}
              {tasks.map((t) => (
                <div key={t.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="border-white/20 text-zinc-300">{TYPE_AR[t.type]}</Badge>
                      {statusBadge(t.status)}
                      <span className="font-mono text-[10px] text-zinc-500" dir="ltr">{t.model}</span>
                    </div>
                    <span className="text-[10px] text-zinc-500">{new Date(t.created_at + "Z").toLocaleString("ar", { hour12: false })}</span>
                  </div>
                  {t.prompt && <p className="text-xs text-zinc-400 truncate">{t.prompt}</p>}
                  {(t.status === "processing" || t.status === "pending") && <Progress value={t.progress} className="h-1.5" />}
                  {t.status === "completed" && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {t.result_urls.map((u, i) => (
                        <a key={i} href={u} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-300 hover:bg-cyan-500/20">
                          <Link2 className="h-3 w-3" /> فتح النتيجة {t.result_urls.length > 1 ? i + 1 : ""}
                        </a>
                      ))}
                      {t.has_inline_data && <span className="text-[11px] text-zinc-400">(صورة مضمّنة سُلّمت في رد الأداة)</span>}
                    </div>
                  )}
                  {t.status === "failed" && t.error_message && (
                    <p className="text-[11px] text-rose-300/90">❌ {t.error_message}</p>
                  )}
                  <div className="text-[10px] text-zinc-500">
                    المحاولات: {t.attempts.length}
                    {t.attempts.length > 0 && (
                      <span dir="ltr" className="font-mono"> ({t.attempts.map((a) => `${a.provider}:${a.ok ? "ok" : a.errorClass}`).join(", ")})</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* ج) ربط السيرفر */}
        <Card className="border-white/10 bg-white/[0.04] backdrop-blur lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Plug className="h-4.5 w-4.5 text-cyan-400" />
              ربط السيرفر بعميل MCP
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* رابط MCP */}
            <div className="flex gap-2 max-w-2xl">
              <Input
                readOnly
                value={mcpUrl}
                dir="ltr"
                className="flex-1 border-white/15 bg-white/5 font-mono text-xs text-cyan-300"
              />
              <Button onClick={() => copy(mcpUrl, "رابط MCP")} variant="outline" className="border-white/15 text-zinc-300 hover:bg-white/10">
                <Copy className="h-4 w-4" /> نسخ
              </Button>
            </div>

            <Tabs defaultValue="chatgpt" dir="rtl" className="w-full">
              <TabsList className="bg-white/5 border border-white/10">
                <TabsTrigger value="chatgpt" className="text-xs">ChatGPT / GPT Agents</TabsTrigger>
                <TabsTrigger value="claude" className="text-xs">Claude Desktop</TabsTrigger>
                <TabsTrigger value="cursor" className="text-xs">Cursor / Windsurf / Cline</TabsTrigger>
              </TabsList>
              <TabsContent value="chatgpt" className="space-y-2">
                <p className="text-xs text-zinc-400">في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».</p>
                <pre dir="ltr" className="max-h-48 overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-[11px] leading-5 text-cyan-200 text-left">{chatgptJson}</pre>
                <Button size="sm" variant="outline" onClick={() => copy(chatgptJson, "إعداد ChatGPT")} className="border-white/15 text-zinc-300 hover:bg-white/10">
                  <Copy className="h-3.5 w-3.5" /> نسخ JSON
                </Button>
              </TabsContent>
              <TabsContent value="claude" className="space-y-2">
                <p className="text-xs text-zinc-400">أضفه إلى ملف claude_desktop_config.json مع <span dir="ltr" className="font-mono">&quot;type&quot;: &quot;http&quot;</span></p>
                <pre dir="ltr" className="max-h-48 overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-[11px] leading-5 text-cyan-200 text-left">{claudeJson}</pre>
                <Button size="sm" variant="outline" onClick={() => copy(claudeJson, "إعداد Claude")} className="border-white/15 text-zinc-300 hover:bg-white/10">
                  <Copy className="h-3.5 w-3.5" /> نسخ JSON
                </Button>
              </TabsContent>
              <TabsContent value="cursor" className="space-y-2">
                <p className="text-xs text-zinc-400">أضفه إلى mcp.json داخل Cursor / Windsurf / Cline.</p>
                <pre dir="ltr" className="max-h-48 overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-[11px] leading-5 text-cyan-200 text-left">{cursorJson}</pre>
                <Button size="sm" variant="outline" onClick={() => copy(cursorJson, "إعداد Cursor")} className="border-white/15 text-zinc-300 hover:bg-white/10">
                  <Copy className="h-3.5 w-3.5" /> نسخ JSON
                </Button>
              </TabsContent>
            </Tabs>

            {/* رقائق الأدوات */}
            <div className="flex flex-wrap gap-2 pt-1">
              {TOOL_CHIPS.map((t) => (
                <div key={t.name} className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5">
                  <span dir="ltr" className="font-mono text-[11px] font-semibold text-violet-300">{t.name}</span>
                  <span className="text-[11px] text-zinc-400">{t.desc}</span>
                </div>
              ))}
            </div>

            {/* ملاحظة كهرمانية */}
            <div className="flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-6 text-amber-200/90">
              <CircleAlert className="mt-1 h-4 w-4 shrink-0 text-amber-400" />
              الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال المهمة يُعرض
              الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
            </div>
          </CardContent>
        </Card>
      </main>

      <footer className="relative border-t border-white/10 py-4 text-center text-[11px] text-zinc-500">
        خادم MCP لتوليد الوسائط — التبديل التسلسلي للمفاتيح يعمل تلقائيًا ولا يرى العميل أخطاء المفاتيح أو الرصيد أبدًا.
      </footer>
    </div>
  );
}
