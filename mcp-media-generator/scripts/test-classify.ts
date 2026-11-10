/**
 * اختبار منطق تصنيف الأخطاء (جدول 4.2) — يثبت:
 * 402 → exhausted (يبقى في القاعدة) | 401/403 → disabled | نفاد الرصيد برسالة 400 → exhausted
 * model not found → provider | 400 معطيات → params | 429/5xx/شبكة → temporary
 */
import { classifyProviderError } from "../src/lib/keys";

let passed = 0, failed = 0;
function check(name: string, actual: string, expected: string) {
  if (actual === expected) { passed++; console.log(`✅ ${name} → ${actual}`); }
  else { failed++; console.log(`❌ ${name} → ${actual} (المتوقع ${expected})`); }
}

check("HTTP 402 → exhausted", classifyProviderError(402, "Payment Required"), "exhausted");
check("رسالة insufficient بحالة 400 → exhausted (تُفحص قبل 400)", classifyProviderError(400, "insufficient balance"), "exhausted");
check("رسالة quota → exhausted", classifyProviderError(500, "quota exceeded"), "exhausted");
check("رسالة 充值 → exhausted", classifyProviderError(400, "请充值后重试"), "exhausted");
check("HTTP 401 → disabled", classifyProviderError(401, "Unauthorized"), "disabled");
check("HTTP 403 → disabled", classifyProviderError(403, "forbidden"), "disabled");
check("invalid api key بحالة 400 → disabled", classifyProviderError(400, "invalid api key"), "disabled");
check("model not found بحالة 404 → provider", classifyProviderError(404, "model not found"), "provider");
check("unsupported model بحالة 422 → provider", classifyProviderError(422, "unsupported model"), "provider");
check("400 معطيات عادية → params (توقف فوري)", classifyProviderError(400, "prompt is required"), "params");
check("422 معطيات → params", classifyProviderError(422, "invalid aspect_ratio"), "params");
check("429 → temporary", classifyProviderError(429, "rate limited"), "temporary");
check("500 → temporary", classifyProviderError(500, "internal error"), "temporary");
check("503 → temporary", classifyProviderError(503, "service unavailable"), "temporary");
check("انقطاع شبكة (status 0) → temporary", classifyProviderError(0, "fetch failed"), "temporary");

console.log(`\n===== نتيجة اختبار التصنيف: ${passed} ناجح / ${failed} فاشل =====`);
process.exit(failed > 0 ? 1 : 0);
