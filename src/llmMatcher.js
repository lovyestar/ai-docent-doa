import { docentData } from "./data.js";
import { matchQuestion } from "./matcher.js";

// Only one general-answer clip is ever playing/shown at a time, so
// releasing the previous blob right before making a new one is enough
// to keep this from leaking over a long kiosk session — no need to
// track a whole pool of them.
let lastGeneralAudioUrl = null;

function base64ToAudioUrl(base64) {
  if (lastGeneralAudioUrl) URL.revokeObjectURL(lastGeneralAudioUrl);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  lastGeneralAudioUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
  return lastGeneralAudioUrl;
}

/**
 * Asks the backend to classify which booth item the question is
 * about. If it's about none of them, the backend instead returns a
 * short free-form answer (generalAnswer) generated on the spot, plus
 * a freshly-synthesized audioBase64 for it (best-effort — null if
 * ElevenLabs isn't configured or the call failed) — that comes back
 * here as a synthetic "general" entry so the caller can display and
 * speak it like any other answer. Falls back to the local keyword
 * matcher if the API call fails, times out, or the backend is
 * unreachable — a booth demo shouldn't go silent just because the
 * classify server hiccupped (that fallback has no LLM to ask, so it
 * can only match a known entry or give up, same as before).
 */
export async function classifyQuestion(text, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("/api/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`classify failed: ${res.status}`);
    const data = await res.json();
    if (data.entryId) {
      return docentData.find((e) => e.id === data.entryId) || null;
    }
    if (data.generalAnswer) {
      const audioUrl = data.audioBase64 ? base64ToAudioUrl(data.audioBase64) : null;
      return { id: null, category: "general", title: "도아의 답변", description: data.generalAnswer, audioUrl };
    }
    return null;
  } catch (e) {
    console.warn("LLM classify unavailable, falling back to keyword match:", e.message);
    return matchQuestion(text);
  } finally {
    clearTimeout(timer);
  }
}
