/**
 * converter.js
 *
 * Chuyển đổi giữa Anthropic Messages API và OpenAI Chat Completions API.
 *
 * Anthropic → OpenAI (request)
 * OpenAI    → Anthropic (response — cả streaming lẫn non-streaming)
 */

import { config } from "./config.js";

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST: Anthropic → OpenAI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chuyển một content block Anthropic thành OpenAI message content.
 * Hỗ trợ text, image (base64 & url), tool_use, tool_result.
 */
function convertContentBlock(block) {
  if (typeof block === "string") return block;

  switch (block.type) {
    case "text":
      return block.text;

    case "image": {
      const { source } = block;
      if (source.type === "base64") {
        return {
          type: "image_url",
          image_url: { url: `data:${source.media_type};base64,${source.data}` },
        };
      }
      if (source.type === "url") {
        return { type: "image_url", image_url: { url: source.url } };
      }
      return `[Image: ${source.type}]`;
    }

    case "tool_use":
      // Trong Anthropic, đây là lúc model gọi tool.
      // Phía OpenAI tool_use nằm trong assistant message → xử lý ở buildMessages
      return null;

    case "tool_result":
      // Nội dung kết quả tool (array hoặc string)
      if (Array.isArray(block.content)) {
        return block.content.map((b) => convertContentBlock(b)).filter(Boolean).join("\n");
      }
      return typeof block.content === "string" ? block.content : JSON.stringify(block.content);

    default:
      return null;
  }
}

/**
 * Chuẩn hóa content Anthropic thành mảng block.
 */
function normalizeContent(content) {
  if (!content) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [content];
}

/**
 * Chuyển mảng messages Anthropic → mảng messages OpenAI.
 *
 * Xử lý:
 * - tool_use (assistant calling tool) → assistant + tool_calls
 * - tool_result (user returning tool result) → tool message
 * - image → multimodal content
 */
function buildOpenAIMessages(anthropicMessages) {
  const result = [];

  for (const msg of anthropicMessages) {
    const blocks = normalizeContent(msg.content);

    if (msg.role === "assistant") {
      // Tách tool_use và text ra riêng
      const toolUseBlocks = blocks.filter((b) => b.type === "tool_use");
      const textBlocks = blocks.filter((b) => b.type === "text");
      const thinkingBlocks = blocks.filter((b) => b.type === "thinking");

      const oaiMsg = { role: "assistant" };

      // Nội dung text + thinking
      const textParts = [];
      for (const tb of thinkingBlocks) {
        textParts.push(`[Thinking]\n${tb.thinking}`);
      }
      for (const tb of textBlocks) {
        textParts.push(tb.text);
      }
      if (textParts.length > 0) oaiMsg.content = textParts.join("\n");

      // Tool calls
      if (toolUseBlocks.length > 0) {
        oaiMsg.tool_calls = toolUseBlocks.map((b) => ({
          id: b.id,
          type: "function",
          function: {
            name: b.name,
            arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input),
          },
        }));
      }

      result.push(oaiMsg);
    } else if (msg.role === "user") {
      // Kiểm tra xem có tool_result không
      const toolResultBlocks = blocks.filter((b) => b.type === "tool_result");
      const otherBlocks = blocks.filter((b) => b.type !== "tool_result");

      // Thêm tool results trước (phải match với tool_calls ở assistant message trước đó)
      for (const tr of toolResultBlocks) {
        const content = convertContentBlock(tr);
        result.push({
          role: "tool",
          tool_call_id: tr.tool_use_id,
          content: content || "",
        });
      }

      // Thêm user message nếu còn nội dung khác
      if (otherBlocks.length > 0) {
        const parts = otherBlocks.map((b) => convertContentBlock(b)).filter(Boolean);

        // Multimodal hay text thuần?
        const hasComplex = otherBlocks.some((b) => b.type === "image");
        if (hasComplex) {
          const contentArr = [];
          for (const b of otherBlocks) {
            if (b.type === "text") {
              contentArr.push({ type: "text", text: b.text });
            } else if (b.type === "image") {
              const converted = convertContentBlock(b);
              if (converted && typeof converted === "object") contentArr.push(converted);
            }
          }
          result.push({ role: "user", content: contentArr });
        } else {
          result.push({ role: "user", content: parts.join("\n") });
        }
      }
    }
  }

  return result;
}

/**
 * Chuyển tools Anthropic → tools OpenAI.
 */
function convertTools(anthropicTools) {
  if (!anthropicTools || anthropicTools.length === 0) return undefined;
  return anthropicTools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));
}

/**
 * Chuyển tool_choice Anthropic → tool_choice OpenAI.
 */
function convertToolChoice(tc) {
  if (!tc) return undefined;
  if (tc.type === "auto") return "auto";
  if (tc.type === "none") return "none";
  if (tc.type === "any") return "required";
  if (tc.type === "tool") return { type: "function", function: { name: tc.name } };
  return undefined;
}

/**
 * Giải quyết tên model: dùng map nếu có, rồi DEFAULT_MODEL, rồi giữ nguyên.
 */
function resolveModel(anthropicModel) {
  if (config.modelMap[anthropicModel]) return config.modelMap[anthropicModel];
  if (config.defaultModel) return config.defaultModel;
  return anthropicModel;
}

/**
 * Hàm chính: chuyển Anthropic request → OpenAI request body.
 */
export function anthropicToOpenAI(body) {
  const messages = [];

  // System prompt
  if (body.system) {
    const systemText =
      typeof body.system === "string"
        ? body.system
        : normalizeContent(body.system)
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("\n");
    if (systemText.trim()) {
      messages.push({ role: "system", content: systemText });
    }
  }

  // User/assistant messages
  messages.push(...buildOpenAIMessages(body.messages || []));

  const openaiBody = {
    model: resolveModel(body.model || "gpt-4o"),
    messages,
    stream: body.stream || false,
  };

  if (body.max_tokens != null) openaiBody.max_tokens = body.max_tokens;
  if (body.temperature != null) openaiBody.temperature = body.temperature;
  if (body.top_p != null) openaiBody.top_p = body.top_p;
  if (body.stop_sequences?.length) openaiBody.stop = body.stop_sequences;

  const tools = convertTools(body.tools);
  if (tools) openaiBody.tools = tools;

  const toolChoice = convertToolChoice(body.tool_choice);
  if (toolChoice !== undefined) openaiBody.tool_choice = toolChoice;

  return openaiBody;
}

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSE: OpenAI → Anthropic
// ─────────────────────────────────────────────────────────────────────────────

function mapFinishReason(reason) {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

/**
 * Chuyển OpenAI non-streaming response → Anthropic response.
 */
export function openAIToAnthropic(openaiResp, anthropicModel) {
  const choice = openaiResp.choices?.[0];
  if (!choice) throw new Error("No choices in OpenAI response");

  const oaiMsg = choice.message;
  const content = [];

  if (oaiMsg.content) {
    content.push({ type: "text", text: oaiMsg.content });
  }

  if (oaiMsg.tool_calls?.length) {
    for (const tc of oaiMsg.tool_calls) {
      let input;
      try {
        input = JSON.parse(tc.function.arguments || "{}");
      } catch {
        input = tc.function.arguments || {};
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  return {
    id: `msg_${openaiResp.id?.replace(/^chatcmpl-/, "") || Date.now()}`,
    type: "message",
    role: "assistant",
    model: anthropicModel || openaiResp.model || "unknown",
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    content,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STREAMING: OpenAI SSE → Anthropic SSE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generator: nhận OpenAI SSE chunks (mảng string lines), yield Anthropic SSE events.
 *
 * Anthropic streaming event order:
 *   message_start
 *   content_block_start  (index 0)
 *   ping
 *   content_block_delta* (text_delta)
 *   content_block_stop
 *   message_delta        (stop_reason, usage)
 *   message_stop
 */
export function streamConverter(anthropicModel) {
  // State
  let messageId = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let sentMessageStart = false;
  let sentContentBlockStart = false;
  let currentTextIndex = 0;
  let toolCallMap = {}; // id → { index, name, argsBuf }
  let toolCallOrder = []; // ordered list of tool_call ids
  let currentBlockIndex = 0;
  let stopReason = null;

  /** Emit một SSE event (trả về string) */
  function event(name, data) {
    return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  /**
   * Gửi một OpenAI delta chunk, nhận về mảng SSE event strings.
   * Yield từng event.
   */
  function* processChunk(chunk) {
    const { id, choices, usage } = chunk;

    // Thu thập usage nếu có
    if (usage) {
      inputTokens = usage.prompt_tokens || 0;
      outputTokens = usage.completion_tokens || 0;
    }

    // message_start (chỉ gửi 1 lần)
    if (!sentMessageStart) {
      messageId = `msg_${(id || Date.now().toString()).replace(/^chatcmpl-/, "")}`;
      sentMessageStart = true;
      yield event("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          model: anthropicModel || "unknown",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 1 },
        },
      });
      yield event("ping", { type: "ping" });
    }

    if (!choices || choices.length === 0) return;
    const choice = choices[0];
    const delta = choice.delta;

    // ── Text delta ───────────────────────────────────────────────
    if (delta?.content) {
      if (!sentContentBlockStart) {
        sentContentBlockStart = true;
        currentBlockIndex = 0;
        yield event("content_block_start", {
          type: "content_block_start",
          index: currentBlockIndex,
          content_block: { type: "text", text: "" },
        });
      }
      yield event("content_block_delta", {
        type: "content_block_delta",
        index: currentBlockIndex,
        delta: { type: "text_delta", text: delta.content },
      });
      outputTokens++;
    }

    // ── Tool call deltas ─────────────────────────────────────────
    if (delta?.tool_calls?.length) {
      // Nếu đang có text block mở → đóng lại trước
      if (sentContentBlockStart && !toolCallOrder.length) {
        yield event("content_block_stop", {
          type: "content_block_stop",
          index: currentBlockIndex,
        });
        currentBlockIndex++;
        sentContentBlockStart = false; // reset, không mở text block nữa
      }

      for (const tc of delta.tool_calls) {
        const tcIndex = tc.index ?? 0;

        // Tìm tool call theo index
        let tcId = toolCallOrder[tcIndex];
        if (!tcId && tc.id) {
          tcId = tc.id;
          toolCallOrder[tcIndex] = tcId;
          toolCallMap[tcId] = {
            blockIndex: currentBlockIndex,
            name: tc.function?.name || "",
            argsBuf: "",
          };
          // content_block_start cho tool_use
          yield event("content_block_start", {
            type: "content_block_start",
            index: currentBlockIndex,
            content_block: {
              type: "tool_use",
              id: tcId,
              name: tc.function?.name || "",
              input: {},
            },
          });
          currentBlockIndex++;
        }

        if (tcId) {
          const state = toolCallMap[tcId];
          // Cập nhật name nếu đến sau
          if (tc.function?.name) state.name += tc.function.name;
          // Arguments delta
          if (tc.function?.arguments) {
            state.argsBuf += tc.function.arguments;
            yield event("content_block_delta", {
              type: "content_block_delta",
              index: state.blockIndex,
              delta: { type: "input_json_delta", partial_json: tc.function.arguments },
            });
          }
        }
      }
    }

    // ── Finish ───────────────────────────────────────────────────
    if (choice.finish_reason) {
      stopReason = mapFinishReason(choice.finish_reason);
    }
  }

  // ── Finalize stream ────────────────────────────────────────────
  function* finalize() {
    // Đóng text block nếu đang mở
    if (sentContentBlockStart && !toolCallOrder.length) {
      yield event("content_block_stop", {
        type: "content_block_stop",
        index: 0,
      });
    }

    // Đóng tất cả tool_use blocks
    for (const tcId of toolCallOrder) {
      if (tcId && toolCallMap[tcId]) {
        yield event("content_block_stop", {
          type: "content_block_stop",
          index: toolCallMap[tcId].blockIndex,
        });
      }
    }

    // Nếu không có gì được gửi, gửi empty text block
    if (!sentContentBlockStart && toolCallOrder.length === 0) {
      yield event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      yield event("content_block_stop", {
        type: "content_block_stop",
        index: 0,
      });
    }

    yield event("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: stopReason || "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: outputTokens },
    });

    yield event("message_stop", { type: "message_stop" });
  }

  // Trả về object có processChunk và finalize
  return { processChunk, finalize };
}
