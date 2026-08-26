import { docentData } from "./data.js";

function normalize(str) {
  return str.replace(/\s+/g, "").toLowerCase();
}

/**
 * Finds the DB entry whose keyword best matches the question.
 * Picks the longest matching keyword so more specific phrases win
 * over generic ones (e.g. "과목 나침반" over "나침반").
 */
export function matchQuestion(question) {
  const q = normalize(question);
  if (!q) return null;

  let best = null;
  let bestLen = 0;

  for (const entry of docentData) {
    for (const keyword of entry.keywords) {
      const k = normalize(keyword);
      if (k && q.includes(k) && k.length > bestLen) {
        best = entry;
        bestLen = k.length;
      }
    }
  }

  return best;
}
