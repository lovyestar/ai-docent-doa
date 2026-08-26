// One-time generation script: renders every fixed line the avatar can
// say into an mp3 via ElevenLabs, using the "도아" voice designed for
// this project. Not part of the running app — run manually whenever
// data.js's spoken text changes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { docentData, idlePhrases, uiText } from "../src/data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "public", "audio");
const VOICE_ID = "EV9NO6ZSnzhzdT8v4ALa"; // "도아" — designed voice, saved in ElevenLabs account
const MODEL_ID = "eleven_multilingual_v2";
const API_KEY = process.env.ELEVENLABS_API_KEY;

if (!API_KEY) {
  console.error("ELEVENLABS_API_KEY is not set (expected in .env)");
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const lines = [
  ...docentData.map((e) => ({ file: `${e.id}.mp3`, text: e.speech || e.description })),
  ...idlePhrases.map((text, i) => ({ file: `idle-${i + 1}.mp3`, text })),
  { file: "fallback.mp3", text: uiText.fallback },
];

async function generate(file, text) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
    method: "POST",
    headers: { "xi-api-key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: MODEL_ID,
      voice_settings: { stability: 0.45, similarity_boost: 0.85, style: 0.35 },
    }),
  });
  if (!res.ok) {
    throw new Error(`${file}: HTTP ${res.status} ${await res.text()}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(OUT_DIR, file), buf);
  console.log(`${file} (${buf.length} bytes)`);
}

const filters = process.argv.slice(2);
const targets = filters.length ? lines.filter((l) => filters.some((f) => l.file.includes(f))) : lines;

for (const { file, text } of targets) {
  await generate(file, text);
  // ElevenLabs rate-limits bursts on lower tiers — a small gap keeps
  // this reliable without needing retry logic for a one-off script.
  await new Promise((r) => setTimeout(r, 400));
}

console.log(`\nDone — ${targets.length} files in ${OUT_DIR}`);
