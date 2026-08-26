import { docentData } from "./data.js";
import { matchQuestion } from "./matcher.js";

/**
 * Asks the backend to classify which booth item the question is
 * about. Falls back to the local keyword matcher if the API call
 * fails, times out, or the backend is unreachable — a booth demo
 * shouldn't go silent just because the classify server hiccupped.
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
    if (!data.entryId) return null;
    return docentData.find((e) => e.id === data.entryId) || null;
  } catch (e) {
    console.warn("LLM classify unavailable, falling back to keyword match:", e.message);
    return matchQuestion(text);
  } finally {
    clearTimeout(timer);
  }
}
