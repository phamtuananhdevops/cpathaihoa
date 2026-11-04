// api/log-question.js — Ghi cau hoi an danh vao Vercel Blob (Vercel Serverless Function)
// Chi nhan POST voi JSON { question, timestamp }.
// Moi cau hoi duoc luu thanh mot file JSON rieng duoi thu muc questions/.
// Khong luu ten, IP, user-agent hay cau tra loi. Khong yeu cau xac thuc.
// Loi Blob -> tra 500 (frontend bo qua loi log).

const BLOB_API = "https://blob.vercel-storage.com/";

function randomSuffix(n) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed — chi nhan POST." });
    return;
  }

  let body = req.body || {};
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    res.status(400).json({ ok: false, error: "Thieu cau hoi: 'question' phai la chuoi khong rong." });
    return;
  }

  const q = question.slice(0, 2000);
  const ts = typeof body.timestamp === "string" && body.timestamp
    ? body.timestamp.slice(0, 64)
    : new Date().toISOString();

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    res.status(500).json({ ok: false, error: "Server chua cau hinh BLOB_READ_WRITE_TOKEN." });
    return;
  }

  // Ten file: timestamp + hau to ngau nhien -> moi cau hoi mot file rieng.
  const safeTs = ts.replace(/[^0-9A-Za-z-]/g, "-").slice(0, 40) || "no-ts";
  const pathname = "questions/" + safeTs + "-" + randomSuffix(8) + ".json";

  try {
    const r = await fetch(BLOB_API + pathname, {
      method: "PUT",
      headers: {
        authorization: "Bearer " + token,
        "x-api-version": "7",
        "x-content-type": "application/json",
        "x-access": "private",
        "x-add-random-suffix": "0"
      },
      body: JSON.stringify({ question: q, timestamp: ts })
    });
    if (!r.ok) {
      let detail = "";
      try { detail = await r.text(); } catch (e) {}
      throw new Error("Blob upload failed: " + r.status + " " + detail.slice(0, 200));
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Khong luu duoc cau hoi." });
  }
};
