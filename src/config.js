/**
 * config.js — Đọc cấu hình từ biến môi trường
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Tự load .env nếu có (Node 20.6+ hỗ trợ --env-file, nhưng ta tự parse để tương thích hơn)
function loadDotenv() {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadDotenv();

// Parse MODEL_MAP: "claude-x=gpt-4o,claude-y=gpt-4o-mini"
function parseModelMap(raw) {
  const map = {};
  if (!raw) return map;
  for (const pair of raw.split(",")) {
    const [from, to] = pair.split("=");
    if (from && to) map[from.trim()] = to.trim();
  }
  return map;
}

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || "http://localhost:11434/v1").replace(/\/$/, ""),
  openaiApiKey: process.env.OPENAI_API_KEY || "none",
  defaultModel: process.env.DEFAULT_MODEL || "",
  modelMap: parseModelMap(process.env.MODEL_MAP || ""),
};
