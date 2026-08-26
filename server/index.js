import express from "express";
import { docentData } from "../src/data.js";

const PORT = process.env.PORT || 3001;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-haiku-4-5-20251001";
// A public kiosk mic shouldn't be able to hammer a paid API — one
// classification per visitor question is plenty, so anything faster
// than this from the same IP is almost certainly a double-fire, not a
// second real question.
const MIN_INTERVAL_MS = 1500;

if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set (expected in server/.env)");
  process.exit(1);
}

const entrySummaries = docentData
  .map((e) => `id: ${e.id}\n제목: ${e.title}\n키워드: ${e.keywords.join(", ")}`)
  .join("\n\n");

const classifyTool = {
  name: "classify_question",
  description: "방문객의 질문이 부스 전시물 중 어떤 것에 대한 것인지 분류한다.",
  input_schema: {
    type: "object",
    properties: {
      entryId: {
        type: ["string", "null"],
        description: "가장 일치하는 전시물의 id. 어떤 전시물과도 명확히 관련 없으면 null.",
        enum: [...docentData.map((e) => e.id), null],
      },
    },
    required: ["entryId"],
  },
};

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const lastRequestAt = new Map();

app.post("/api/classify", async (req, res) => {
  const text = (req.body?.text || "").trim();
  if (!text) return res.json({ entryId: null });

  const ip = req.ip;
  const now = Date.now();
  if (now - (lastRequestAt.get(ip) || 0) < MIN_INTERVAL_MS) {
    return res.status(429).json({ error: "rate_limited" });
  }
  lastRequestAt.set(ip, now);

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        system:
          "너는 부스 안내 키오스크의 질문 분류기다. 다음은 부스에 있는 전시물 목록이다:\n\n" +
          entrySummaries +
          "\n\n방문객의 질문을 보고 이 중 어떤 전시물에 대한 질문인지 판단해라. " +
          "\"안녕\", \"안녕하세요\", \"반가워\" 같은 인사말이면 반드시 entryId를 \"self-docent\"로 해라 (null이 아니다). " +
          "\"AI 도슨트가 뭐야\", \"AI 도슨트란\" 처럼 AI 도슨트라는 개념/역할 자체를 묻는 질문이면 \"ai-docent-role\"로 해라. " +
          "\"도아가 뭐야\", \"도아가 누구야\" 처럼 도아라는 이름의 정체를 묻는 질문이면 \"self-docent\"로 해라 — 이 둘은 서로 다른 항목이니 혼동하지 마라. " +
          "\"트래커는 어떤 기술을 사용했나요\", \"과목나침반은 어떤 기술을 사용했나요\", \"SmartEval은 어떤 기술을 사용했나요\", \"제스쳐 고는 어떤 기술을 사용했나요\" 처럼 작품 하나를 콕 집어 그 제작 기술을 묻는 질문이면 \"ai-tech\"가 아니라 각각 \"tracker-tech\", \"subject-compass-tech\", \"camera-scanner-tech\", \"gesture-go-tech\"로 해라. \"이 작품들은 어떤 AI 기술을 사용했나요\"처럼 특정 작품을 지목하지 않고 전체 작품에 쓰인 기술을 통틀어 묻는 질문일 때만 \"ai-tech\"로 해라 — 이 둘은 서로 다른 항목이니 혼동하지 마라. " +
          "그 외에 잡담이거나 어떤 전시물과도 명확히 관련 없는 질문이면 entryId를 null로 해라.",
        messages: [{ role: "user", content: text }],
        tools: [classifyTool],
        tool_choice: { type: "tool", name: "classify_question" },
      }),
    });

    if (!r.ok) {
      console.error("Anthropic API error", r.status, await r.text());
      return res.status(502).json({ error: "upstream_error" });
    }

    const data = await r.json();
    const toolUse = data.content?.find((c) => c.type === "tool_use");
    res.json({ entryId: toolUse?.input?.entryId ?? null });
  } catch (e) {
    console.error("classify failed", e);
    res.status(500).json({ error: "server_error" });
  }
});

app.listen(PORT, () => {
  console.log(`docent server listening on :${PORT}`);
});
