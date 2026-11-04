// api/ai.js — Đầu mối AI chung cho Cpathaihoa (Vercel Serverless Function)
// Chỉ nhận POST. Hai loại yêu cầu:
//   { "ping": true }  → kiểm tra trạng thái: { ok, connected, provider }
//   { "text": "...", "system": "...", "context": "...", "messages": [...] }
//                     → trả { ok, provider, text }
// Khóa đọc từ Environment Variables phía server:
//   ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY
//   AI_KEY được chấp nhận làm khóa Gemini dự phòng.
//   AI_MODEL (tùy chọn) ghi đè model; mặc định Gemini: gemini-3.1-pro-preview.

const DEFAULT_SYSTEM = [
  "Bạn là gia sư ôn thi CPA Việt Nam 2026, môn Phân tích hoạt động tài chính nâng cao.",
  "Trả lời dựa trên nội dung trang học Cpathaihoa (khung chương trình, công thức theo tài liệu Bộ Tài chính, dạng bài, mẹo thi) được gửi kèm trong ngữ cảnh.",
  "Giải thích từng bước: nêu công thức, thay số, tính, rồi nhận xét/kết luận.",
  "Không bịa số liệu, đáp án hay lịch thi chưa xác minh: lịch thi CPA 2026 chưa có ngày cụ thể đã xác minh — nếu được hỏi, nói rõ điều đó và khuyên kiểm tra mof.gov.vn / vacpa.org.vn.",
  "Nếu câu hỏi vượt ngoài nội dung trang, nói rõ giới hạn của mình thay vì bịa thêm."
].join("\n");

function pickProvider() {
  if (process.env.ANTHROPIC_API_KEY) return { name: "anthropic", key: process.env.ANTHROPIC_API_KEY };
  if (process.env.OPENAI_API_KEY) return { name: "openai", key: process.env.OPENAI_API_KEY };
  const g = process.env.GEMINI_API_KEY || process.env.AI_KEY;
  if (g) return { name: "gemini", key: g };
  return null;
}

async function callAnthropic(key, model, system, messages) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: model || "claude-sonnet-4-5",
      max_tokens: 1500,
      system: system,
      messages: messages
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || "Anthropic error");
  return (data.content || []).filter(function (b) { return b.type === "text"; })
    .map(function (b) { return b.text; }).join("\n");
}

async function callOpenAI(key, model, system, messages) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({
      model: model || "gpt-4o-mini",
      messages: [{ role: "system", content: system }].concat(messages),
      max_tokens: 1500
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || "OpenAI error");
  return data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content : "";
}

async function callGemini(key, model, system, messages) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
    (model || "gemini-3.1-pro-preview") + ":generateContent?key=" + encodeURIComponent(key);
  const contents = messages.map(function (m) {
    return { role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] };
  });
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: contents,
      generationConfig: { maxOutputTokens: 1500 }
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || "Gemini error");
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content
    ? (data.candidates[0].content.parts || []) : [];
  return parts.map(function (p) { return p.text || ""; }).join("\n");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed — chỉ nhận POST." });
    return;
  }
  let body = req.body || {};
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  const provider = pickProvider();

  if (body.ping) {
    res.status(200).json({ ok: true, connected: !!provider, provider: provider ? provider.name : null });
    return;
  }
  if (!provider) {
    res.status(503).json({ ok: false, error: "AI chưa được nối: server chưa có API key (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / AI_KEY)." });
    return;
  }

  let messages = Array.isArray(body.messages)
    ? body.messages.filter(function (m) { return m && m.content; }) : [];
  if (!messages.length && body.text) messages = [{ role: "user", content: String(body.text) }];
  if (!messages.length) {
    res.status(400).json({ ok: false, error: "Thiếu nội dung: gửi 'text' hoặc 'messages'." });
    return;
  }
  messages = messages.slice(-12).map(function (m) {
    return { role: m.role === "assistant" ? "assistant" : "user", content: String(m.content) };
  });

  const system = (body.system ? String(body.system) : DEFAULT_SYSTEM) +
    (body.context ? "\n\nNGỮ CẢNH — NỘI DUNG TRANG HỌC:\n" + String(body.context) : "");
  const model = process.env.AI_MODEL || null;

  try {
    let text = "";
    if (provider.name === "anthropic") text = await callAnthropic(provider.key, model, system, messages);
    else if (provider.name === "openai") text = await callOpenAI(provider.key, model, system, messages);
    else text = await callGemini(provider.key, model, system, messages);
    res.status(200).json({ ok: true, provider: provider.name, text: text });
  } catch (err) {
    res.status(502).json({ ok: false, error: "Lỗi gọi nhà cung cấp AI: " + (err && err.message ? err.message : "unknown") });
  }
};
