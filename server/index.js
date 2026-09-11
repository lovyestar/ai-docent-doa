import express from "express";
import { docentData } from "../src/data.js";

const PORT = process.env.PORT || 3001;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const MODEL = "claude-haiku-4-5-20251001";
const ELEVEN_VOICE_ID = "EV9NO6ZSnzhzdT8v4ALa"; // "도아" — designed voice, saved in ElevenLabs account
const ELEVEN_MODEL_ID = "eleven_multilingual_v2";
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
  description: "방문객의 질문이 부스 전시물 중 어떤 것에 대한 것인지 분류하고, 관련 없는 질문이면 대신 짧게 답변한다.",
  input_schema: {
    type: "object",
    properties: {
      entryId: {
        type: ["string", "null"],
        description: "가장 일치하는 전시물의 id. 어떤 전시물과도 명확히 관련 없으면 null.",
        enum: [...docentData.map((e) => e.id), null],
      },
      generalAnswer: {
        type: "string",
        description:
          "entryId가 null일 때만 채운다. 부스와 무관한 그 질문에 대한 실제 답변을 도아의 말투로 2~3줄 정도로 짧게 작성한다.",
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

// Synthesizes a one-off line for a free-form LLM answer that has no
// pre-generated mp3 (unlike docentData entries, which are rendered
// offline by scripts/generate-tts.js). Returns null (never throws) so
// a TTS hiccup just falls back to the text-only bubble.
async function synthesizeSpeech(text) {
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`, {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: ELEVEN_MODEL_ID,
        voice_settings: { stability: 0.45, similarity_boost: 0.85, style: 0.35 },
      }),
    });
    if (!r.ok) {
      console.error("ElevenLabs TTS error", r.status, await r.text());
      return null;
    }
    return Buffer.from(await r.arrayBuffer()).toString("base64");
  } catch (e) {
    console.error("ElevenLabs TTS fetch failed", e);
    return null;
  }
}

app.post("/api/classify", async (req, res) => {
  const text = (req.body?.text || "").trim();
  if (!text) return res.json({ entryId: null, generalAnswer: null, audioBase64: null });

  const ip = req.ip;
  const now = Date.now();
  if (now - (lastRequestAt.get(ip) || 0) < MIN_INTERVAL_MS) {
    return res.status(429).json({ error: "rate_limited" });
  }
  lastRequestAt.set(ip, now);

  const requestBody = JSON.stringify({
    model: MODEL,
    max_tokens: 400,
    system:
      "너는 부스 안내 키오스크의 질문 분류기다. 다음은 부스에 있는 전시물 목록이다:\n\n" +
      entrySummaries +
      "\n\n방문객의 질문을 보고 이 중 어떤 전시물에 대한 질문인지 판단해라. " +
      "이 텍스트는 실시간 음성 인식(STT)으로 받아쓴 것이라 발음이 비슷한 다른 단어로 잘못 받아써졌을 수 있다. " +
      "글자 그대로의 뜻이 부스 전시물과 안 맞아 보여도, 발음이 비슷한 전시물 이름이나 키워드를 잘못 알아들은 건 아닌지 먼저 의심하고 그쪽으로 분류해라. " +
      "예를 들어 \"광명건설\", \"광명 건설\", \"광명건축\" 같은 텍스트는 \"광명고\"를 잘못 알아들은 것일 가능성이 높으니 \"school-intro\"로 분류해라. " +
      "\"광명고\", \"광명고등학교\"에 대한 질문은 위치를 묻는 질문(\"어디 있어\", \"위치가 어디야\")을 포함해서 항상 \"school-intro\"로 분류하고 절대 null로 하지 마라. " +
      "이 부스에서 말하는 광명고는 부산광역시 영도구에 있는 학교이니, 다른 지역에 있는 동명의 학교와 절대 혼동하지 말고 영도구 기준으로만 설명해라. " +
      "\"안녕\", \"안녕하세요\", \"반가워\" 같은 인사말이면 반드시 entryId를 \"self-docent\"로 해라 (null이 아니다). " +
      "\"AI 도슨트가 뭐야\", \"AI 도슨트란\" 처럼 AI 도슨트라는 개념/역할 자체를 묻는 질문이면 \"ai-docent-role\"로 해라. " +
      "\"도아가 뭐야\", \"도아가 누구야\" 처럼 도아라는 이름의 정체를 묻는 질문이면 \"self-docent\"로 해라 — 이 둘은 서로 다른 항목이니 혼동하지 마라. " +
      "\"트래커는 어떤 기술을 사용했나요\", \"과목나침반은 어떤 기술을 사용했나요\", \"SmartEval은 어떤 기술을 사용했나요\", \"제스쳐 고는 어떤 기술을 사용했나요\" 처럼 작품 하나를 콕 집어 그 제작 기술을 묻는 질문이면 \"ai-tech\"가 아니라 각각 \"tracker-tech\", \"subject-compass-tech\", \"camera-scanner-tech\", \"gesture-go-tech\"로 해라. \"이 작품들은 어떤 AI 기술을 사용했나요\"처럼 특정 작품을 지목하지 않고 전체 작품에 쓰인 기술을 통틀어 묻는 질문일 때만 \"ai-tech\"로 해라 — 이 둘은 서로 다른 항목이니 혼동하지 마라. " +
      "그 외에 잡담이거나 어떤 전시물과도 명확히 관련 없는 질문이면 entryId를 null로 하고, 대신 generalAnswer에 그 질문에 대한 실제 답변을 채워라. " +
      "너는 부스를 지키는 발랄한 여고생 AI 도슨트 '도아'다 — 부스와 상관없는 질문이라도 친근한 반말로, 2~3줄 정도로 짧고 자연스럽게 답해줘라. " +
      "예를 들어 \"오늘 점심 뭐 먹지?\"라는 질문에는 \"음, 초밥 어때? 든든하게 먹어야 부스 구경도 힘차게 하지!\"처럼 짧고 재치있게 답하면 된다. " +
      "entryId가 null이 아니면 generalAnswer는 비워둬라.",
    messages: [{ role: "user", content: text }],
    tools: [classifyTool],
    tool_choice: { type: "tool", name: "classify_question" },
  });

  // Cloudflare Workers' outbound fetches to api.anthropic.com sometimes
  // get rejected with a 403 depending on which edge PoP handled the
  // request (network routing, not an auth/credit issue) — kept here
  // too so this file stays behaviorally identical to worker/index.js.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: requestBody,
      });

      if (r.ok) {
        const data = await r.json();
        const toolUse = data.content?.find((c) => c.type === "tool_use");
        const entryId = toolUse?.input?.entryId ?? null;
        const generalAnswer = entryId ? null : (toolUse?.input?.generalAnswer || null);

        let audioBase64 = null;
        if (!entryId && generalAnswer && ELEVENLABS_API_KEY) {
          audioBase64 = await synthesizeSpeech(generalAnswer);
        }

        return res.json({ entryId, generalAnswer, audioBase64 });
      }

      console.error(`Anthropic API error (attempt ${attempt}/${MAX_ATTEMPTS})`, r.status, await r.text());
    } catch (e) {
      console.error(`classify fetch failed (attempt ${attempt}/${MAX_ATTEMPTS})`, e);
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 350));
  }

  res.status(502).json({ error: "upstream_error" });
});

app.listen(PORT, () => {
  console.log(`docent server listening on :${PORT}`);
});
