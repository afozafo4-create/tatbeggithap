# دمج الفيديوهات — Video Merger API v2

خدمة دمج فيديوهات كاملة مع واجهة برمجية عامة (API) للمطورين، جاهزة للنشر على **Vercel**، مبنية بـ **Node.js خالص (CommonJS)** بدون أي خطوة بناء:

- **واجهة عربية RTL ثيم داكن** (تدرجات سماوي/بنفسجي) لرفع الروابط أو الملفات وترتيبها ودمجها مع تقدم حي.
- **API عام مفتوح CORS** بلا تسجيل دخول، والأخطاء دائمًا بصيغة `{"error":"..."}` برسائل عربية.
- **Turso (libSQL)** تخزّن كل شيء: المهام، أجزاء ملفات المصادر، والفيديو الناتج (Blobs) — لا S3 ولا خدمات خارجية.
- **ffmpeg + ffprobe** داخل الدالة نفسها (`ffmpeg-static` / `ffprobe-static`).
- المخرجات: **MP4 (H.264 CRF 18 + AAC 192k/44100Hz)** حتى 1080p مع `+faststart` — بلا معاملات resolution/fps (الناتج ثابت).

---

## هيكل المشروع

```
api/      دوال Vercel Serverless (واجهة API العامة)
lib/      المنطق: قاعدة البيانات، التخزين التدفقي، محرك الدمج، أدوات مشتركة
public/   الواجهة (ملف واحد HTML+CSS+JS)
tests/    اختبار وحدات + اختبار HTTP كامل
scripts/  أدوات مساعدة (اختياري)
server.js خادم تطوير محلي يحاكي Vercel (يحلّل المسارات الديناميكية ويضعها في req.query)
.env.example قالب المتغيرات بدون قيم حقيقية — لا تضع أسرارًا في المستودع إطلاقًا
```

---

## الخطوة 1: إنشاء قاعدة Turso مجانية

```bash
# ثبّت واجهة Turso إن لم تكن مثبتة
curl -sSfL https://get.tur.so/install.sh | bash

# سجّل دخولك وأنشئ قاعدة
turso auth signup          # أو turso auth login
turso db create tatbegturos1

# اجلب رابط الاتصال والتوكن
turso db show tatbegturos1 --url      # ← هذا TURSO_DATABASE_URL
turso db tokens create tatbegturos1   # ← هذا TURSO_AUTH_TOKEN (صلاحيات كتابة)
```

> الجداول (`jobs`, `sources`, `source_chunks`, `output_chunks`) تُنشأ تلقائيًا عند أول طلب — لا حاجة لأي أداة migrations.

## الخطوة 2: النشر على Vercel خطوة بخطوة

1. ارفع المشروع إلى مستودع Git (تأكد أن `.env` في `.gitignore` — موجود منذ اليوم الأول).
2. في [vercel.com](https://vercel.com): **Add New → Project** واختر المستودع.
3. قبل الضغط على Deploy: **Environment Variables** وأضف المتغيرين الإلزاميين:

   | المتغير | القيمة |
   |---|---|
   | `TURSO_DATABASE_URL` | `libsql://<db-name>-<org>.turso.io` |
   | `TURSO_AUTH_TOKEN` | التوكن من `turso db tokens create` |

4. (اختياري) عدّل الحدود — انظر جدول المتغيرات أدناه.
5. **Deploy**. لا خطوات بناء ولا إعدادات إضافية — `vercel.json` يضبط `maxDuration: 300` لكل الدوال + Cron يومي عند الساعة 03:00 لتنظيف المهام المنتهية.
6. بعد النشر افتح رابط المشروع — ستظهر الواجهة العربية فورًا، وقسم «توثيق API» يعرض أمثلة curl بالدومين الحقيقي.

> ملاحظة: ثنائي ffmpeg يُنزَّل مع الحزمة (`ffmpeg-static`)، وعند فقد صلاحية التنفيذ في الاستضافة تقوم دالة `ensureExecutable` بنسخه إلى `/tmp` بصلاحية 755 تلقائيًا.

## الخطوة 3: تجربة الـ API بـ curl بعد النشر

```bash
BASE=https://your-app.vercel.app

# فحص الجهوزية والحدود
curl $BASE/api/config

# 1) إنشاء مهمة دمج من روابط
curl -X POST $BASE/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}'
# → 201 {"jobId":"...","status":"queued","statusUrl":"...","processUrl":"...","expiresAt":"..."}

# 2) تنفيذ الدمج (متزامن ~10-15 ثانية)
curl -X POST $BASE/api/jobs/<jobId>/process
# → 200 {"status":"done","videoUrl":"...","downloadUrl":"...","size":1234567,"duration":30.2,"resolution":"640x360","expiresAt":"..."}

# 3) الاستعلام عن الحالة والتقدم
curl $BASE/api/jobs/<jobId>
# → {"jobId":"...","status":"done","progress":100,"videoUrl":"...","downloadUrl":"..."}
# ملاحظة دفاعية: قد يرد الجسم فيه error بدون حقل status → عاملها failed فورًا.

# 4) تحميل الناتج
curl -o merged.mp4 "$BASE/api/jobs/<jobId>/video?download=1"

# 5) بث جزء من الناتج (Range)
curl -H 'Range: bytes=0-1023' "$BASE/api/jobs/<jobId>/video"
# → 206 Partial Content + Content-Range: bytes 0-1023/<total>

# 6) رفع ملف من الجهاز (أجزاء ثنائية 4MB — حد حجم الطلب في Vercel ≈ 4.5MB)
# أنشئ المهمة بمصدر ملف ثم ارفع الأجزاء بالترتيب:
curl -X POST "$BASE/api/upload?job=<jobId>&seq=1&chunk=0" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @part0.bin

# 7) حذف فوري شامل
curl -X DELETE $BASE/api/jobs/<jobId>

# 8) تنظيف المهام المنتهية (يعمل تلقائيًا يوميًا)
curl $BASE/api/cron
```

### إنشاء مهمة بمصادر مختلطة (رابط + ملف)

```bash
curl -X POST $BASE/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{"sources":[{"kind":"url","url":"https://example.com/a.mp4"},{"kind":"file","name":"b.mp4","size":57202,"mime":"video/mp4"}]}'
# → 201 مع uploads[] برابط رفع لكل مصدر ملف + uploadChunkBytes
```

---

## جدول متغيرات البيئة

| المتغير | إلزامي | الافتراضي | الوظيفة |
|---|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | — | رابط قاعدة Turso |
| `TURSO_AUTH_TOKEN` | ✅ | — | توكن بصلاحيات كتابة |
| `MAX_SOURCES` | — | `10` | أقصى عدد مقاطع للدمج |
| `SOURCE_MAX_MB` | — | `200` | أقصى حجم لكل مصدر |
| `OUTPUT_MAX_MB` | — | `150` | أقصى حجم للناتج |
| `MAX_TOTAL_DURATION_SEC` | — | `600` | مجموع مدد المقاطع |
| `FFMPEG_PRESET` | — | `medium` | سرعة/جودة الترميز |
| `FFMPEG_PATH` / `FFPROBE_PATH` | — | من ffmpeg-static | تجاوز مسار الثنائيات |
| `PORT` | — | `3030` | منفذ خادم التطوير المحلي |

## الحدود

- **10 مقاطع** كحد أقصى لكل عملية دمج.
- **200MB** لكل رابط/ملف مصدر، **150MB** لحجم الناتج، **600 ثانية** مجموع مدد المقاطع.
- رفع الأجزاء: **4MB** لكل طلب (`application/octet-stream`) مع إعادة محاولة ×3 من الواجهة.
- **كل الملفات تُحذف تلقائيًا بعد 24 ساعة** (`expiresAt` في كل الاستجابات + Cron يومي + تنظيف كسول عند كل إنشاء/دمج).
- الناتج MP4 ثابت: أكبر دقة بين المدخلات (بحد 1920×1080)، fps=30، CRF 18، AAC 192k/44100Hz.

## تشغيل محلي

```bash
cp .env.example .env        # وضع قيم Turso الحقيقية
npm install                 # أو bun install
npm run dev                 # node server.js → http://localhost:3030
npm test                    # اختبار الوحدات ثم اختبار HTTP ضد الخادم المحلي
```

## حدود الخطة المجانية التي يجب معرفتها

- **Vercel Hobby**: مدة الدالة حتى **60 ثانية** افتراضيًا (مع `maxDuration: 300` تتوفر حتى 300 ثانية على خطط Pro؛ في Hobby تتوقف عند 60 — الدمج المتزامن مناسب للمقاطع القصيرة، وللمقاطع الطويلة استخدم Pro أو قلّل الأحجام).
- **حجم الطلب**: ≈ **4.5MB** لذلك الرفع بالأجزاء إلزامي (الواجهة تفعله تلقائيًا).
- **Turso Free**: تخزين قاعدة حتى **5GB** وحجم صف محدود — لذلك يُقسَّم كل Blob إلى صفوف 2MB وتُقرأ بصفحات من 8 صفوف؛ وبعد نجاح الدمج تُحذف أجزاء المصادر ويبقى الناتج فقط.
- الاعتماد كامل على قاعدة البيانات و `/tmp` أثناء المعالجة فقط (يُنظَّف في `finally`) — لا نظام ملفات دائم.

## اختبارات ما قبل التسليم (تُشغَّل قبل الاعتماد على النشر)

```bash
npm run dev          # الطرفية 1
npm test             # الطرفية 2 — اختبار وحدات (14) + اختبار HTTP (21)
```

- **اختبار الوحدات**: يولّد فيديوهين مختلفي الدقة بـ ffmpeg (720p بصوت + 360p بلا صوت)، يدمجهما عبر المحرك، ويتحقق: اكتمال الدمج، الدقة = أكبر دقة مدخل، المدة ≈ مجموع المدد، وجود الصوت، ثم التخزين في Turso والاسترجاع بتطابق sha256، ومسار رفع الأجزاء، وحدود الحجم، والحذف الشامل.
- **اختبار HTTP**: إنشاء مهمة من روابط → دمج → بث مع Range 206 → مهمة مختلطة (رابط + ملف مرفوع) → حذف → 404 → JSON تالف → قائمة فارغة → الروابط الداخلية → تجاوز حد المصادر.
