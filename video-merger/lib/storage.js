/**
 * التخزين التدفقي — تحويل صفوف الـ Blobs إلى Readable stream
 * مع تقليم أول/آخر جزء حسب المدى المطلوب (Range) لدعم 206 + Content-Range
 */
const { Readable } = require("stream");
const store = require("./db");

/**
 * يعيد Readable stream لمحتوى المخزَّن (output أو مصدر) ضمن المدى [start, end) بالبايت
 */
function blobToStream(table, jobId, seq, start = 0, end = Number.MAX_SAFE_INTEGER) {
  let afterChunk = -1;
  let chunkBuf = null;
  let chunkOffset = 0;
  let pos = start; // الموضع المطلق التالي للقراءة
  const CHUNK_SIZE = store.CHUNK_SIZE;

  async function* generator() {
    // نتحرك حتى نصل إلى أول جزء يحتوي بداية المدى
    if (start > 0) {
      afterChunk = Math.floor(start / CHUNK_SIZE) - 1;
      chunkOffset = start % CHUNK_SIZE;
    }
    let reached = start >= end;
    while (!reached) {
      const rows = await store.readBlobRows(table, jobId, seq, afterChunk, 8);
      if (!rows.length) break;
      for (const row of rows) {
        afterChunk = row.chunk;
        const data = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
        const absStart = row.chunk * CHUNK_SIZE;
        const absEnd = absStart + data.length;
        if (absEnd <= start) continue; // قبل المدى
        let from = Math.max(0, start - absStart);
        if (chunkBuf === row.chunk) {
          from = chunkOffset;
        }
        let to = Math.min(data.length, end - absStart);
        if (to <= from) {
          reached = true;
          break;
        }
        yield data.subarray(from, to);
        pos = absStart + to;
        if (pos >= end) {
          reached = true;
          break;
        }
      }
      if (rows.length < 8 && !reached) break; // لا صفوف أكثر
    }
  }

  return Readable.from(generator());
}

module.exports = { blobToStream };
