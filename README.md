# Anthropic Proxy — Node.js

Proxy server nhận request theo **Anthropic Messages API** (`/v1/messages`) và chuyển sang **OpenAI Chat Completions API** (`/v1/chat/completions`).

Dùng được với **Claude CLI** (`claude`), **Claude Code**, và bất kỳ client nào hỗ trợ Anthropic SDK.

## Tính năng

- ✅ `POST /v1/messages` — Anthropic Messages API đầy đủ
- ✅ Streaming SSE (`stream: true`) — chuyển OpenAI chunks → Anthropic events
- ✅ Tool use / Function calling (cả streaming lẫn non-streaming)
- ✅ Multimodal (image base64 & URL)
- ✅ System prompt
- ✅ Model mapping (claude-xxx → tên model thật)
- ✅ `GET /v1/models` — trả danh sách model
- ✅ Không có dependencies nặng (chỉ dùng `express`)

## Yêu cầu

- Node.js >= 18
- Backend OpenAI-compatible đang chạy (Ollama, LM Studio, vLLM, Together, Groq, v.v.)

## Cài đặt nhanh

```bash
# Clone hoặc copy thư mục này vào máy
cd anthropic-proxy

# Cài dependencies
npm install

# Cấu hình (copy từ .env.example rồi sửa)
cp .env.example .env
# Sửa OPENAI_BASE_URL, OPENAI_API_KEY, MODEL_MAP theo backend của bạn

# Chạy server
npm start
```

## Cấu hình (.env)

| Biến | Mô tả | Mặc định |
|------|-------|---------|
| `PORT` | Port lắng nghe | `3000` |
| `OPENAI_BASE_URL` | URL backend OpenAI-compatible | `http://localhost:11434/v1` |
| `OPENAI_API_KEY` | API key backend | `none` |
| `DEFAULT_MODEL` | Model mặc định (để trống = passthrough) | `` |
| `MODEL_MAP` | Map tên model `from=to,from2=to2` | `` |

### Ví dụ MODEL_MAP

```env
# Ollama với llama3
MODEL_MAP=claude-opus-4-6=llama3.2:latest,claude-3-5-sonnet-20241022=llama3.2:latest

# Groq
MODEL_MAP=claude-opus-4-6=llama-3.3-70b-versatile,claude-3-haiku-20240307=llama-3.1-8b-instant
```

## Dùng với Claude CLI

```bash
# Terminal 1: chạy proxy
npm start

# Terminal 2: set env và chạy claude
export ANTHROPIC_BASE_URL=http://localhost:3000
export ANTHROPIC_API_KEY=any-string   # bất kỳ giá trị nào, proxy sẽ dùng OPENAI_API_KEY
claude
```

Hoặc thêm vào `~/.bashrc` / `~/.zshrc`:
```bash
export ANTHROPIC_BASE_URL=http://localhost:3000
export ANTHROPIC_API_KEY=proxy
```

## Dùng với Anthropic SDK (Python/Node)

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:3000",
    api_key="any-string",
)

message = client.messages.create(
    model="claude-opus-4-6",   # sẽ được map theo MODEL_MAP
    max_tokens=1024,
    messages=[{"role": "user", "content": "Xin chào!"}],
)
print(message.content[0].text)
```

```js
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://localhost:3000",
  apiKey: "any-string",
});

const msg = await client.messages.create({
  model: "claude-opus-4-6",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(msg.content[0].text);
```

## Test nhanh bằng curl

```bash
# Non-streaming
curl http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: test" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-opus-4-6",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Xin chào! Bạn là ai?"}]
  }'

# Streaming
curl http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: test" \
  -H "anthropic-version: 2023-06-01" \
  -N \
  -d '{
    "model": "claude-opus-4-6",
    "max_tokens": 256,
    "stream": true,
    "messages": [{"role": "user", "content": "Đếm từ 1 đến 5"}]
  }'
```

## Cấu trúc file

```
anthropic-proxy/
├── src/
│   ├── server.js      # Express server, routes
│   ├── converter.js   # Anthropic ↔ OpenAI conversion logic
│   ├── proxy.js       # Gọi backend OpenAI-compatible
│   └── config.js      # Đọc biến môi trường
├── .env               # Cấu hình (tạo từ .env.example)
├── .env.example       # Template
├── package.json
└── README.md
```

## Backends được kiểm tra

| Backend | URL mặc định | Ghi chú |
|---------|-------------|---------|
| Ollama | `http://localhost:11434/v1` | `ollama serve` |
| LM Studio | `http://localhost:1234/v1` | Enable local server |
| vLLM | `http://localhost:8000/v1` | |
| Together AI | `https://api.together.xyz/v1` | Cần API key |
| Groq | `https://api.groq.com/openai/v1` | Cần API key |
| OpenRouter | `https://openrouter.ai/api/v1` | Cần API key |
