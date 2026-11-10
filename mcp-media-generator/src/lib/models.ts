/**
 * سجل الموديلات والمزودون
 * الأسماء قابلة للتجاوز بمتغيرات بيئة: KIE_IMAGE_MODEL, KIE_VIDEO_MODEL,
 * COMETAPI_IMAGE_MODEL, COMETAPI_VIDEO_MODEL
 */

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string;          // الاسم كما يراه عميل MCP
  aliases: string[];          // صيغ بديلة نقبلها ونوحّدها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[];    // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

/** اسم الموديل لكل مزود مع إمكانية التجاوز بمتغيرات البيئة */
function providerModelFor(
  provider: ProviderId,
  kind: "image" | "video",
  fallback: string
): string {
  const envMap: Record<ProviderId, Record<"image" | "video", string | undefined>> = {
    kie: {
      image: process.env.KIE_IMAGE_MODEL,
      video: process.env.KIE_VIDEO_MODEL,
    },
    cometapi: {
      image: process.env.COMETAPI_IMAGE_MODEL,
      video: process.env.COMETAPI_VIDEO_MODEL,
    },
  };
  return envMap[provider][kind] || fallback;
}

/** الموديلات المدمجة — الموديلان الأساسيان من المواصفة + nano-banana-pro (موديل صور إضافي مطلوب من المستخدم،
 *  مُقاس فعليًا لدى kie.ai: ينتج صور JPEG ويستهلك ~18 رصيدًا) */
export function getModels(): ModelDef[] {
  const imageCanonical = "gpt-image-2-6/flare-text-to-image";
  const videoCanonical = "grok-imagine-video-1-5-preview";
  // موديل صور إضافي بطلب المستخدم — أُثبت أنه مولّد صور (وليس فيديو) عبر نداء حقيقي
  const nanoImage = process.env.KIE_NANO_IMAGE_MODEL || "nano-banana-pro";

  return [
    {
      canonical: imageCanonical,
      aliases: [
        imageCanonical,
        "gpt-image-2.6/flare-text-to-image", // صيغة بديلة بالنقاط نوحّدها
      ],
      type: "image",
      providers: ["kie", "cometapi"],
      providerModel: {
        kie: providerModelFor("kie", "image", "gpt-image-2-6/flare-text-to-image"),
        cometapi: providerModelFor("cometapi", "image", "gpt-image-2.6-flare-text-to-image"),
      },
    },
    {
      canonical: nanoImage,
      aliases: [nanoImage, "nano-banana-pro", "nano-banana.2-pro", "google/nano-banana-pro"],
      type: "image",
      providers: ["kie", "cometapi"],
      providerModel: {
        kie: nanoImage,
        // الاسم لدى CometAPI غير مُتحقق منه (لا مفتاح للتجربة) — قابل للتجاوز بمتغير البيئة
        cometapi: process.env.COMETAPI_NANO_IMAGE_MODEL || "nano-banana-pro",
      },
    },
    {
      canonical: videoCanonical,
      aliases: [
        videoCanonical,
        "grok-imagine-video-1.5-preview", // صيغة بديلة بالنقاط نوحّدها
      ],
      type: "video",
      providers: ["kie", "cometapi"],
      providerModel: {
        kie: providerModelFor("kie", "video", "grok-imagine-video-1-5-preview"),
        cometapi: providerModelFor("cometapi", "video", "grok-imagine-video-1-5-preview"),
      },
    },
  ];
}

/** توحيد اسم الموديل عبر aliases — يرمي خطأ معطيات فوريًا عند الاسم غير المعروف */
export function normalizeModel(input: string): ModelDef {
  const trimmed = (input || "").trim();
  const models = getModels();
  for (const m of models) {
    if (m.aliases.includes(trimmed) || m.canonical === trimmed) return m;
  }
  throw new Error(
    `موديل غير معروف: «${trimmed}». المتاح: ${models.map((m) => m.canonical).join(" ، ")}`
  );
}

export function findModelByCanonical(canonical: string): ModelDef | undefined {
  return getModels().find((m) => m.canonical === canonical);
}
