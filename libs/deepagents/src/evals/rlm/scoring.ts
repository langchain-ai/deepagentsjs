/**
 * Multi-strategy scoring for OOLONG benchmark answers.
 *
 * Ported from rlming/oolong_benchmark/scripts/run_rlm.py — uses the same
 * four-strategy matching (exact, normalized, contains, numeric) so results
 * are directly comparable to the Python benchmark harness.
 */

const NUMERIC_RE = /[-+]?\d+(?:\.\d+)?/;

export interface Score {
  pred: string;
  gold: string;
  correct: boolean;
  exactMatch: boolean;
  normalizedMatch: boolean;
  containsMatch: boolean;
  numericMatch: boolean;
}

/**
 * Collapse whitespace and lowercase for fuzzy comparison.
 */
function normalizeText(value: string): string {
  return value.trim().toLowerCase().split(/\s+/).join(" ");
}

/**
 * Strip markdown bold/italic markers.
 */
function stripMarkdown(value: string): string {
  let text = value.trim();
  while (text.startsWith("**") && text.endsWith("**")) {
    text = text.slice(2, -2).trim();
  }
  while (
    text.startsWith("*") &&
    text.endsWith("*") &&
    !text.startsWith("**")
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/**
 * Extract the canonical prediction from raw model output.
 *
 * Matches the Python rlming `_canonical_prediction` exactly:
 * 1. Strip known answer prefixes from the full text
 * 2. If multi-line, return the first non-empty line
 * 3. Strip markdown bold/italic markers
 */
export function canonicalPrediction(value: string): string {
  let text = value.trim();
  const prefixes = ["final answer:", "answer:", "label:", "user:"];

  // Strip known prefix from beginning of text (matching Python logic)
  const lowered = text.toLowerCase();
  for (const prefix of prefixes) {
    if (lowered.startsWith(prefix)) {
      text = text.slice(prefix.length).trim();
      break;
    }
  }

  // If multi-line, return first non-empty line
  if (text.includes("\n")) {
    const firstLine = text.split("\n")[0].trim();
    if (firstLine) {
      return stripMarkdown(firstLine);
    }
  }

  return stripMarkdown(text);
}

/**
 * Extract the first number from a string, ignoring commas.
 */
function firstNumber(value: string): string | null {
  const match = NUMERIC_RE.exec(value.replace(/,/g, ""));
  return match ? match[0] : null;
}

/**
 * Parse a gold answer that may be a JSON array string like `['answer']`.
 */
export function parseGold(raw: unknown): string {
  let gold = raw;
  if (Array.isArray(gold)) {
    gold = gold.length > 0 ? gold[0] : "";
  }
  let goldStr = String(gold).trim();

  if (goldStr.startsWith("[") && goldStr.endsWith("]")) {
    try {
      const parsed = JSON.parse(goldStr.replace(/'/g, '"'));
      if (Array.isArray(parsed) && parsed.length > 0) {
        goldStr = String(parsed[0]).trim();
      }
    } catch {
      // keep as-is
    }
  }
  return goldStr;
}

/**
 * Score a model output against a gold answer using four strategies.
 *
 * A prediction is correct if ANY of the four strategies match.
 */
export function scoreOutput(output: string, goldAnswer: string): Score {
  const pred = canonicalPrediction(output);
  const exactMatch = pred.trim() === goldAnswer.trim();
  const normalizedMatch = normalizeText(pred) === normalizeText(goldAnswer);
  const containsMatch = normalizeText(pred).includes(
    normalizeText(goldAnswer),
  );

  const goldNum = firstNumber(goldAnswer);
  const predNum = firstNumber(pred);
  const numericMatch =
    goldNum !== null && predNum !== null && goldNum === predNum;

  return {
    pred,
    gold: goldAnswer,
    correct: exactMatch || normalizedMatch || containsMatch || numericMatch,
    exactMatch,
    normalizedMatch,
    containsMatch,
    numericMatch,
  };
}
