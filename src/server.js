/**
 * server.js — Entry point
 *
 * Anthropic-compatible proxy server.
 * Nhận POST /v1/messages theo Anthropic Messages API,
 * chuyển sang OpenAI Chat Completions, trả về response Anthropic format.
 *
 * Dùng với Claude CLI:
 *   export ANTHROPIC_BASE_URL=http://localhost:3000
 *   export ANTHROPIC_API_KEY=any-string
 *   claude
 */

import express from "express";
import { config } from "./config.js";
import { anthropicToOpenAI, openAIToAnthropic, streamConverter } from "./converter.js";
import { callOpenAI, streamOpenAI } from "./proxy.js";

const app = express();

// ─── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json({ limit: "50mb" }));

// Logging nhẹ
app.use((req, _res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.path}`);
  next();
});

// CORS (hữu ích khi dùng từ browser/web UI)
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta"
  );
  next();
});

app.options("*", (_req, res) => res.sendStatus(200));

// ─── Helper: lấy API key từ client ────────────────────────────────────────────

function extractClientApiKey(req) {
  const auth = req.headers["authorization"];
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return req.headers["x-api-key"] || null;
}

// ─── Helper: trả về lỗi dạng Anthropic ───────────────────────────────────────

function sendError(res, status, type, message) {
  return res.status(status).json({
    type: "error",
    error: { type, message },
  });
}

// ─── Route: health check ──────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({
    name: "anthropic-proxy",
    status: "ok",
    backend: config.openaiBaseUrl,
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ─── Helper: đếm tokens (ước lượng) ───────────────────────────────────────────

/**
 * Ước lượng số tokens từ text (approx 1 token ≈ 4 characters in English)
 * Hoặc đếm words * 1.3 nếu text ngắn
 */
function estimateTokens(text) {
  if (!text) return 0;
  const chars = text.length;
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * Đếm tokens từ content blocks Anthropic
 */
function countTokensFromBlocks(blocks) {
  let total = 0;
  for (const block of blocks) {
    if (typeof block === "string") {
      total += estimateTokens(block);
    } else {
      switch (block.type) {
        case "text":
          total += estimateTokens(block.text);
          break;
        case "image":
          // Image tokens: ước lượng 85 tokens per image (Anthropic default)
          total += 85;
          break;
        case "tool_result":
          if (block.content) {
            total += countTokensFromContent(block.content);
          }
          break;
        default:
          break;
      }
    }
  }
  return total;
}

function countTokensFromContent(content) {
  if (!content) return 0;
  if (typeof content === "string") return estimateTokens(content);
  if (Array.isArray(content)) return countTokensFromBlocks(content);
  return 0;
}

/**
 * Đếm tokens từ system prompt
 */
function countSystemTokens(system) {
  if (!system) return 0;
  if (typeof system === "string") return estimateTokens(system);
  if (Array.isArray(system)) return countTokensFromBlocks(system);
  return 0;
}

// ─── Route: POST /v1/messages/count_tokens ────────────────────────────────────

app.post("/v1/messages/count_tokens", (req, res) => {
  const body = req.body;

  // Validate tối thiểu
  if (!Array.isArray(body.messages)) {
    return sendError(res, 400, "invalid_request_error", "Missing required field: messages");
  }

  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  // Đếm system tokens
  inputTokens += countSystemTokens(body.system);

  // Đếm message tokens
  for (const msg of body.messages) {
    if (msg.role === "system") {
      inputTokens += countTokensFromContent(msg.content);
    } else if (msg.role === "user") {
      inputTokens += countTokensFromContent(msg.content);
    } else if (msg.role === "assistant") {
      // Assistant messages cũng tính vào input (context)
      inputTokens += countTokensFromContent(msg.content);
    }
  }

  // Nếu có cache_control, tính thêm cache tokens
  // (OpenAI không hỗ trợ cache counting chính xác, đây là ước lượng)

  return res.json({
    input_tokens: inputTokens,
    cache_read_input_tokens: cacheReadTokens,
    cache_write_input_tokens: cacheWriteTokens,
    estimation: {
      method: "character-based",
      note: "Token count is an approximation. Actual count may vary.",
    },
  });
});

// ─── Route: POST /v1/messages ─────────────────────────────────────────────────

app.post("/v1/messages", async (req, res) => {
  const body = req.body;

  // Validate tối thiểu
  if (!body.model) {
    return sendError(res, 400, "invalid_request_error", "Missing required field: model");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return sendError(res, 400, "invalid_request_error", "Missing required field: messages");
  }

  const clientApiKey = extractClientApiKey(req);
  const anthropicModel = body.model;

  let openaiBody;
  try {
    openaiBody = anthropicToOpenAI(body);
  } catch (err) {
    console.error("[convert] Error:", err);
    return sendError(res, 400, "invalid_request_error", `Request conversion failed: ${err.message}`);
  }

  // ── Non-streaming ──────────────────────────────────────────────
  if (!body.stream) {
    try {
      // thời gian bắt đầu gọi OpenAI, để tính tổng thời gian xử lý request
      const startTime = Date.now();
      const openaiResp = await callOpenAI(openaiBody, clientApiKey);
      const anthropicResp = openAIToAnthropic(openaiResp, anthropicModel);
      const duration = Date.now() - startTime;
      console.log(`[non-stream] Request processed in ${duration} ms`);
      return res.json(anthropicResp);
    } catch (err) {
      const status = err.status || 500;
      const message = typeof err.message === "string" ? err.message : JSON.stringify(err);
      console.error("[non-stream] Backend error:", status, message.slice(0, 200));
      return sendError(
        res,
        status,
        status === 429 ? "rate_limit_error" : "api_error",
        message
      );
    }
  }

  // ── Streaming ──────────────────────────────────────────────────
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // tắt nginx buffering
  res.flushHeaders();

  /** Gửi một SSE event string trực tiếp ra socket */
  function write(eventStr) {
    res.write(eventStr);
  }

  try {
    const conv = streamConverter(anthropicModel);

    for await (const chunk of streamOpenAI(openaiBody, clientApiKey)) {
      for (const eventStr of conv.processChunk(chunk)) {
        write(eventStr);
      }
    }

    // Finalize
    for (const eventStr of conv.finalize()) {
      write(eventStr);
    }
  } catch (err) {
    const status = err.status || 500;
    const message = typeof err.message === "string" ? err.message : JSON.stringify(err);
    console.error("[stream] Backend error:", status, message.slice(0, 200));

    // Gửi error event theo Anthropic streaming format
    write(
      `event: error\ndata: ${JSON.stringify({
        type: "error",
        error: {
          type: status === 429 ? "rate_limit_error" : "api_error",
          message,
        },
      })}\n\n`
    );
  } finally {
    res.end();
  }
});

// ─── Route: GET /v1/models (tùy chọn, giúp client discovery) ─────────────────

app.get("/v1/models", (_req, res) => {
  const models = [
    "claude-opus-4-6",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-haiku-20240307",
    "claude-3-opus-20240229",
    ...Object.keys(config.modelMap),
  ];
  const unique = [...new Set(models)];
  res.json({
    data: unique.map((id) => ({
      id,
      object: "model",
      created: 1700000000,
      owned_by: "proxy",
    })),
    object: "list",
  });
});

// ─── 404 catch-all ────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    type: "error",
    error: {
      type: "not_found_error",
      message: `Route not found: ${req.method} ${req.path}`,
    },
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║           Anthropic Proxy Server - READY              ║");
  console.log("╠═══════════════════════════════════════════════════════╣");
  console.log(`║  Listening on  : http://localhost:${config.port}               ║`);
  console.log(`║  Backend       : ${config.openaiBaseUrl.padEnd(34)} ║`);
  console.log(`║  Default model : ${(config.defaultModel || "(passthrough)").padEnd(34)} ║`);
  console.log("╠═══════════════════════════════════════════════════════╣");
  console.log("║  Claude CLI usage:                                    ║");
  console.log(`║    export ANTHROPIC_BASE_URL=http://localhost:${config.port}    ║`);
  console.log("║    export ANTHROPIC_API_KEY=any-string                ║");
  console.log("║    claude                                             ║");
  console.log("╚═══════════════════════════════════════════════════════╝");

  if (Object.keys(config.modelMap).length > 0) {
    console.log("\nModel mappings:");
    for (const [from, to] of Object.entries(config.modelMap)) {
      console.log(`  ${from} → ${to}`);
    }
  }
});
