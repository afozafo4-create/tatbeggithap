# MCP Media Generator + خدمة دمج الفيديوهات

مشروعان يعملان معًا لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع، مع لوحة إدارة عربية كاملة:

| المشروع | المجلد | الوصف | النشر |
| --- | --- | --- | --- |
| **MCP Media Generator** | `mcp-media-generator/` | خادم MCP (Next.js) بـ 5 أدوات + واجهة إدارة عربية RTL | Vercel |
| **Video Merger API v2** | `video-merger/` | موقع دمج فيديوهات + API عامة (Node.js خالص + ffmpeg + Turso) | Vercel |
| **الوسائط المولّدة** | `media/` | الفيديو والصورة المولّدان فعليًا أثناء اختبارات e2e | — |

## الأدوات الخمس على `/mcp`

`generate_image` · `generate_video` · `merge_videos` · `get_task` · `list_media`

- الموديلات المدمجة: `gpt-image-2-6/flare-text-to-image` و `nano-banana-pro` (صور)، `grok-imagine-video-1-5-preview` (فيديو بصوت متزامن).
- مفاتيح kie.ai / CometAPI تُجرَّب **بترتيب تسلسلي صارم** حسب ترتيب إضافتها مع تبديل تلقائي صامت عند أي خطأ أو نفاد رصيد — العميل لا يرى أخطاء المفاتيح أبدًا.
- لا تُنزَّل أي وسائط على السيرفر — روابط فقط في قاعدة Turso.

## خطوات النشر على Vercel

1. أنشئ قاعدة Turso مجانية: `turso db create <name>` ثم `turso db show <name> --url` و `turso db tokens create <name>`.
2. ارفع هذا المستودع إلى GitHub واربطه بـ Vercel مرتين (مشروعان):
   - مشروع **video-merger**: Root Directory = `video-merger` — متغيرات: `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN`.
   - مشروع **mcp-media-generator**: Root Directory = `mcp-media-generator` — متغيرات: `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` و `MERGER_API_BASE` (رابط نشر مشروع الدمج، مثل `https://<merger>.vercel.app`) + `MCP_ACCESS_TOKEN` اختياري.
3. بعد النشر: افتح واجهة لوحة الإدارة وأضف مفتاح kie.ai من «مدير المفاتيح» ثم اربط أي عميل MCP على `<origin>/mcp`.
4. الفيديو المولّد (اختبار e2e حقيقي) موجود في `media/generated-video.mp4`.

اختبار سريع بعد النشر:
```bash
curl https://<app>.vercel.app/api/health
curl -X POST https://<app>.vercel.app/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

> التفاصيل الكاملة لكل مشروع داخل README الخاص به. الأسرار في `.env*` غير مرفوعة إطلاقًا إلى المستودع.
