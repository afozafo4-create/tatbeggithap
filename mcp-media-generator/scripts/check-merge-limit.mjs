// فحص سريع: رفض أكثر من 10 مقاطع برسالة عربية عبر أداة merge_videos
const urls = Array.from({ length: 11 }, () => "https://www.w3schools.com/html/mov_bbb.mp4");
const BASE = "http://localhost:3000/mcp";
(async () => {
  const init = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
  });
  const sid = init.headers.get("mcp-session-id");
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "merge_videos", arguments: { urls } } }),
  });
  const text = await res.text();
  const data = text.split("\n").filter((l) => l.startsWith("data:")).pop();
  const body = JSON.parse(data.slice(5));
  const msg = body.result?.content?.[0]?.text ?? JSON.stringify(body).slice(0, 200);
  console.log("isError:", body.result?.isError);
  console.log("message:", msg.slice(0, 160));
})();
