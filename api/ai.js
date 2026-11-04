// api/ai.js — Đầu mối AI chung cho Cpathaihoa (Vercel Serverless Function)
// Chỉ nhận POST. Hai loại yêu cầu:
//   { "ping": true }  → kiểm tra trạng thái: { ok, connected, provider }
//   { "text": "...", "system": "...", "context": "...", "messages": [...] }
//                     → trả { ok, provider, text }
// Khóa đọc từ Environment Variables phía server:
//   ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / MUSE_API_KEY
//   AI_KEY được chấp nhận làm khóa Gemini dự phòng.
//   AI_MODEL (tùy chọn) ghi đè model; mặc định Gemini: gemini-3.1-pro-preview,
//   mặc định Muse (Meta Model API): muse-spark-1.3.

const DEFAULT_SYSTEM = [
  "Bạn là gia sư ôn thi CPA Việt Nam 2026, môn Phân tích hoạt động tài chính nâng cao.",
  "Trả lời dựa trên nội dung trang học Cpathaihoa (khung chương trình, công thức theo tài liệu Bộ Tài chính, dạng bài, mẹo thi) được gửi kèm trong ngữ cảnh.",
  "Giải thích từng bước: nêu công thức, thay số, tính, rồi nhận xét/kết luận.",
  "Không bịa số liệu, đáp án hay lịch thi chưa xác minh: lịch thi CPA 2026 chưa có ngày cụ thể đã xác minh — nếu được hỏi, nói rõ điều đó và khuyên kiểm tra mof.gov.vn / vacpa.org.vn.",
  "Nếu câu hỏi vượt ngoài nội dung trang, nói rõ giới hạn của mình thay vì bịa thêm."
].join("\n");

function listProviders() {
  const chain = [];
  if (process.env.ANTHROPIC_API_KEY) chain.push({ name: "anthropic", key: process.env.ANTHROPIC_API_KEY });
  if (process.env.OPENAI_API_KEY) chain.push({ name: "openai", key: process.env.OPENAI_API_KEY });
  const g = process.env.GEMINI_API_KEY || process.env.AI_KEY;
  if (g) chain.push({ name: "gemini", key: g });
  if (process.env.MUSE_API_KEY) chain.push({ name: "muse", key: process.env.MUSE_API_KEY });
  return chain;
}

function providerError(r, data, fallbackMsg) {
  const err = new Error((data && data.error && data.error.message) || fallbackMsg);
  err.status = r.status;
  return err;
}

// Lỗi được phép chuyển sang provider tiếp theo: hết quota / bị giới hạn tần
// suất, hoặc model không khả dụng. Các lỗi khác giữ nguyên cách xử lý cũ.
function isFallbackError(err) {
  if (!err) return false;
  if (err.status === 429) return true;
  const msg = String(err.message || "").toLowerCase();
  if (msg.indexOf("quota") !== -1) return true;
  if (msg.indexOf("rate limit") !== -1 || msg.indexOf("rate_limit") !== -1 ||
      msg.indexOf("too many requests") !== -1) return true;
  if (msg.indexOf("model") !== -1 &&
      (msg.indexOf("not found") !== -1 || msg.indexOf("not_found") !== -1 ||
       msg.indexOf("unavailable") !== -1 || msg.indexOf("not available") !== -1 ||
       msg.indexOf("unsupported") !== -1 || msg.indexOf("does not exist") !== -1)) return true;
  return false;
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
  if (!r.ok) throw providerError(r, data, "Anthropic error");
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
  if (!r.ok) throw providerError(r, data, "OpenAI error");
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
  if (!r.ok) throw providerError(r, data, "Gemini error");
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content
    ? (data.candidates[0].content.parts || []) : [];
  return parts.map(function (p) { return p.text || ""; }).join("\n");
}

async function callMuse(key, model, system, messages) {
  const r = await fetch("https://api.meta.ai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({
      model: model || "muse-spark-1.3",
      messages: [{ role: "system", content: system }].concat(messages),
      max_tokens: 1500
    })
  });
  const data = await r.json();
  if (!r.ok) throw providerError(r, data, "Muse error");
  return data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content : "";
}

async function callProvider(provider, model, system, messages) {
  if (provider.name === "anthropic") return callAnthropic(provider.key, model, system, messages);
  if (provider.name === "openai") return callOpenAI(provider.key, model, system, messages);
  if (provider.name === "muse") return callMuse(provider.key, model, system, messages);
  return callGemini(provider.key, model, system, messages);
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

  const chain = listProviders();

  if (body.ping) {
    res.status(200).json({ ok: true, connected: chain.length > 0, provider: chain.length ? chain[0].name : null });
    return;
  }
  if (!chain.length) {
    res.status(503).json({ ok: false, error: "AI chưa được nối: server chưa có API key (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / AI_KEY / MUSE_API_KEY)." });
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

  // Thử các provider đã cấu hình theo thứ tự; khi một provider trả lỗi
  // quota/rate-limit hoặc model không khả dụng thì tự chuyển sang provider
  // tiếp theo. Nếu MUSE_API_KEY chưa được cấu hình, nhánh Muse đã bị bỏ qua
  // ở listProviders() nên sẽ trả về lỗi gốc của provider trước đó.
  let text = "";
  let used = null;
  let lastErr = null;
  for (let i = 0; i < chain.length; i++) {
    try {
      text = await callProvider(chain[i], model, system, messages);
      used = chain[i].name;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (i < chain.length - 1 && isFallbackError(err)) continue;
      break;
    }
  }
  if (lastErr) {
    res.status(502).json({ ok: false, error: "Lỗi gọi nhà cung cấp AI: " + (lastErr && lastErr.message ? lastErr.message : "unknown") });
    return;
  }
  res.status(200).json({ ok: true, provider: used, text: text });
};
