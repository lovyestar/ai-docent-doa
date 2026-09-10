import { docentData } from "./data.js";
import { matchQuestion } from "./matcher.js";

/**
 * Asks the backend to classify which booth item the question is
 * about. If it's about none of them, the backend instead returns a
 * short free-form answer (generalAnswer) generated on the spot — that
 * comes back here as a synthetic "general" entry so the caller can
 * display it like any other answer, just without audio. Falls back to
 * the local keyword matcher if the API call fails, times out, or the
 * backend is unreachable — a booth demo shouldn't go silent just
 * because the classify server hiccupped (that fallback has no LLM to
 * ask, so it can only match a known entry or give up, same as before).
 */
export async function classifyQuestion(text, { timeoutMs = 6000 } = {}) {
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
      return { id: null, category: "general", title: "도아의 답변", description: data.generalAnswer };
    }
    return null;
  } catch (e) {
    console.warn("LLM classify unavailable, falling back to keyword match:", e.message);
    return matchQuestion(text);
  } finally {
    clearTimeout(timer);
  }
}
