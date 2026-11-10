# مولّد الوسائط MCP — MCP Media Generator

خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع + لوحة إدارة عربية (RTL).

- **خادم MCP على المسار `/mcp`** (نقل Streamable HTTP حسب مواصفات MCP عبر SDK الرسمي) يعرض 5 أدوات: `generate_image` · `generate_video` · `merge_videos` · `get_task` · `list_media` — يعمل من أي عميل (ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline / GPT Agents SDK).
- **واجهة ويب عربية RTL** (`/`) لإدارة مفاتيح API، متابعة المهام حية، وعرض إعدادات الربط جاهزة للنسخ.
- **قاعدة Turso (libSQL عبر HTTP)** — متوافقة مع Vercel serverless، الجداول تُنشأ تلقائيًا عند أول وصول.
- **المزودون**: kie.ai (Jobs API الموحد) + CometAPI (OpenAI-compatible) مع تبديل تسلسلي صامت للمفاتيح حسب ترتيب الإضافة.
- **خدمة دمج الفيديو** (مشروع منفصل في `mini-services/video-merger/` — انظر README داخله).

## القواعد الجوهرية

1. لا يُنزَّل أي ملف وسائط على السيرفر — روابط النتائج فقط في قاعدة البيانات.
2. المفاتيح تُجرَّب بترتيب تسلسلي صارم حسب ترتيب إضافتها (`created_at ASC, id ASC`) — ليس round-robin.
3. تبديل تلقائي فوري عند أي خطأ أو نفاد رصيد — نفس المهمة تُستأنف بنفس `task_id` على المفتاح التالي.
4. نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا.
5. مهمة فشل إنشاؤها على كل المفاتيح تبقى `processing` («بانتظار توفر مفتاح صالح…») وتُعاد محاولتها مع كل `get_task` (تهدئة 45 ثانية).
6. الملفات المدمجة تُحذف من خدمة الدمج بعد 24 ساعة.
7. إخفاء المفاتيح إلزامي في كل الاستجابات (`maskKey`: أول 7 + •••••••• + آخر 4).

## التشغيل المحلي

```bash
cp .env.example .env.local   # ضع قيم Turso الحقيقية
bun install
bun run dev                  # http://localhost:3000
```

خدمة الدمج (منفصلة):

```bash
cd mini-services/video-merger
cp .env.example .env         # نفس قيم Turso (أسماء الجداول لا تتعارض)
npm install && npm run dev   # http://localhost:3030
```

## النشر على Vercel

1. ارفع المستودع إلى Git (`.env*` مستثنى منذ أول commit).
2. أنشئ مشروعًا لكل جزء (الرئيسي + `video-merger` كمشروع مستقل بمجلد الجذر الخاص به).
3. أضف المتغيرات: `TURSO_DATABASE_URL` · `TURSO_AUTH_TOKEN` · `MERGER_API_BASE` (رابط خدمة الدمج المنشورة) — واختياريًا `MCP_ACCESS_TOKEN` لحماية `/mcp` بـ Bearer token.
4. Deploy — كل الاتصالات عبر HTTP (libSQL) ومناسبة للـ serverless، ومسار `/mcp` يدعم الـ streaming.

## بنية الكود

```
src/lib/turso.ts        طبقة القاعدة: عميل واحد + ensureSchema + عمليات المهام
src/lib/keys.ts         قلب المشروع: الحمولة التسلسلية + classifyProviderError + CRUD
src/lib/models.ts       سجل الموديلات (قابل للتجاوز بمتغيرات البيئة)
src/lib/providers/      كيّاي (Jobs API) و CometAPI (OpenAI-compatible)
src/lib/generation.ts   منسّق التوليد: runGeneration + refreshTask بالتبديل الصامت
src/lib/merger.ts       عميل Video Merger API v2 (runMerge + refreshMergeTask)
src/app/mcp/route.ts    خادم MCP (SDK رسمي) — الأدوات الخمس + SERVER_INSTRUCTIONS
src/app/api/            health · keys · keys/[id] · tasks
src/app/page.tsx        لوحة الإدارة العربية (ثلاث بطاقات + تحديث تلقائي)
```

## فحص الجهوزية

```bash
curl http://localhost:3000/api/health
# {"ok":true,"database":"turso-connected","mcpEndpoint":"/mcp","models":[...],"merger":{...},"authRequired":false}

# اختبار MCP سريع (curl)
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}'
```

## أين أحصل على مفاتيح API؟

- **kie.ai**: أنشئ حسابًا في [kie.ai](https://kie.ai) → Dashboard → API Keys.
- **CometAPI**: أنشئ حسابًا في [cometapi.com](https://www.cometapi.com) → Console → API Keys.
- أضف المفاتيح من لوحة الإدارة أعلى الصفحة (بطاقة «مدير المفاتيح») — أضف عدة مفاتيح لكل مزود ليعمل التبديل التلقائي.
