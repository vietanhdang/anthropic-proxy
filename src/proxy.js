/**
 * proxy.js
 *
 * Gọi backend OpenAI-compatible, hỗ trợ cả streaming và non-streaming.
 */

import { config } from "./config.js";

const TIMEOUT_MS = 120_000; // 2 phút

function buildHeaders(clientApiKey) {
  const headers = {
    "Content-Type": "application/json",
    // Authorization: `Bearer ${clientApiKey || config.openaiApiKey}`,
    Authorization: `Bearer ${config.openaiApiKey}`,
  };
  return headers;
}

/**
 * Non-streaming: gửi request tới OpenAI backend, trả về JSON object.
 */
export async function callOpenAI(openaiBody, clientApiKey) {
  const url = `${config.openaiBaseUrl}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: buildHeaders(clientApiKey),
      body: JSON.stringify(openaiBody),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text();
      throw { status: resp.status, message: errText };
    }

    return await resp.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Streaming: gửi request tới OpenAI backend, nhận ReadableStream SSE,
 * yield từng parsed chunk object.
 */
export async function* streamOpenAI(openaiBody, clientApiKey) {
  const url = `${config.openaiBaseUrl}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: buildHeaders(clientApiKey),
      body: JSON.stringify({ ...openaiBody, stream: true }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }

  if (!resp.ok) {
    clearTimeout(timer);
    const errText = await resp.text();
    throw { status: resp.status, message: errText };
  }

  // Đọc SSE line by line
  const decoder = new TextDecoder();
  let buf = "";

  try {
    for await (const rawChunk of resp.body) {
      buf += decoder.decode(rawChunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop(); // phần chưa hoàn chỉnh, giữ lại

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data);
        } catch {
          // bỏ qua các line không phải JSON hợp lệ
        }
      }
    }

    // Flush buffer còn lại
    if (buf.trim().startsWith("data:")) {
      const data = buf.trim().slice(5).trim();
      if (data && data !== "[DONE]") {
        try {
          yield JSON.parse(data);
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
