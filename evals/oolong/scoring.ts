/**
 * Scoring for Oolong benchmark answers.
 *
 * Ported from the official Python harness (oolong_benchmark/src/eval/eval_helpers.py)
 * so results are directly comparable to the paper.
 *
 * Scoring strategy (synth_process_response):
 * 1. Parse answer by splitting on ":" and taking last segment
 * 2. Strip markdown bold/italic markers and brackets
 * 3. Exact string comparison: str(parsed) == str(gold)
 * 4. For ANSWER_TYPE.COMPARISON: substring containment for "more common"/"less common"/"same frequency"
 * 5. For ANSWER_TYPE.NUMERIC: partial credit via 0.75^|gold - pred|
 * 6. For ANSWER_TYPE.DATE: flexible date parsing comparison
 */

const NUMERIC_RE = /[-+]?\d+(?:\.\d+)?/;

/** Comparison phrases that get special substring matching. */
const COMPARISON_PHRASES = [
  "more common than",
  "less common than",
  "same frequency as",
] as const;

export interface Score {
  /** Canonical prediction extracted from model output. */
  pred: string;
  /** Gold answer (scalar string). */
  gold: string;
  /**
   * Numeric score in [0, 1].
   * - 1 for exact/comparison/date matches
   * - 0.75^|diff| for numeric partial credit
   * - 0 for no match
   */
  score: number;
  /** Whether the answer is considered correct (score >= 1). */
  correct: boolean;
  /** Trimmed string equality after parsing. */
  exactMatch: boolean;
  /** Lowercased, whitespace-collapsed equality. */
  normalizedMatch: boolean;
  /** Comparison phrase containment (only for ANSWER_TYPE.COMPARISON). */
  containsMatch: boolean;
  /** Numeric partial-credit match (only for ANSWER_TYPE.NUMERIC). */
  numericMatch: boolean;
}

/** Collapse whitespace and lowercase for fuzzy comparison. */
function normalizeText(value: string): string {
  return value.trim().toLowerCase().split(/\s+/).join(" ");
}

/** Strip markdown bold/italic markers. */
function stripMarkdown(value: string): string {
  let text = value.trim();
  while (text.startsWith("**") && text.endsWith("**")) {
    text = text.slice(2, -2).trim();
  }
  while (text.startsWith("*") && text.endsWith("*") && !text.startsWith("**")) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/** Extract the first number from a string, ignoring commas. */
function firstNumber(value: string): number | null {
  const match = NUMERIC_RE.exec(value.replace(/,/g, ""));
  return match ? Number(match[0]) : null;
}

/**
 * Parse the raw model output into a canonical prediction.
 *
 * Matches the official Python `synth_attempt_answer_parse` logic:
 * 1. If no ":" in the answer and it's short (<20 chars), return as-is
 * 2. If no ":" and it's long, return last word
 * 3. Split on ":" and take the last segment
 * 4. Strip `*`, `[`, `]` characters (model formatting artifacts)
 */
export function canonicalPrediction(value: string): string {
  let text = value.trim();

  // If multi-line, take the last non-empty line (agent often puts answer last)
  if (text.includes("\n")) {
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length > 0) {
      text = lines[lines.length - 1]!.trim();
    }
  }

  if (!text.includes(":")) {
    if (text.length < 20) {
      return stripMarkdown(text);
    }
    // Return last word
    const words = text.split(/\s+/);
    return stripMarkdown(words[words.length - 1] ?? text);
  }

  // Split on ":" and take the last segment
  let candidate = text.split(":").pop()!.trim();

  // Strip markdown bold/italic and brackets (Anthropic/OpenAI formatting)
  candidate = candidate.replace(/\*/g, "");
  candidate = candidate.replace(/\[/g, "");
  candidate = candidate.replace(/\]/g, "");
  candidate = candidate.trim();

  return candidate;
}

/**
 * Parse a gold answer that may be a JSON array string like `['answer']`.
 *
 * Handles:
 * - Plain strings: `"spam"` -> `"spam"`
 * - Python list strings: `"['spam']"` -> `"spam"`
 * - JSON arrays: `["spam"]` -> `"spam"`
 * - Numeric values: `[4]` -> `"4"`
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
 * Try to parse a date string flexibly. Returns null if unparseable.
 *
 * Handles common formats:
 * - ISO 8601: "2024-01-15"
 * - US style: "01/15/2024", "Jan 15, 2024"
 * - Python datetime.date: "datetime.date(2024, 1, 15)"
 */
function tryParseDate(value: string): Date | null {
  // Handle Python datetime.date(...) format from gold answers
  const pyDateMatch = value.match(
    /datetime\.date\((\d{4}),\s*(\d{1,2}),\s*(\d{1,2})\)/,
  );
  if (pyDateMatch) {
    return new Date(
      Number(pyDateMatch[1]),
      Number(pyDateMatch[2]) - 1,
      Number(pyDateMatch[3]),
    );
  }

  const d = new Date(value);
  if (!isNaN(d.getTime())) return d;

  return null;
}

/**
 * Score a model output against a gold answer.
 *
 * Follows the official Oolong scoring methodology:
 *
 * 1. **String match**: `str(parsed) == str(gold)` (after canonical parsing)
 * 2. **Comparison answers**: substring containment for "more/less common", "same frequency"
 * 3. **Numeric answers**: partial credit via `0.75^|gold - pred|`
 * 4. **Date answers**: flexible date parsing comparison
 *
 * @param output - Raw model output text
 * @param goldAnswer - Parsed gold answer string
 * @param answerType - The `answer_type` field from the dataset (e.g. "ANSWER_TYPE.NUMERIC")
 */
export function scoreOutput(
  output: string,
  goldAnswer: string,
  answerType: string,
): Score {
  const pred = canonicalPrediction(output);

  // Strategy 1: exact string match (matches paper's `str(trimmed_output) == str(gold)`)
  const exactMatch = pred.trim() === goldAnswer.trim();

  // Strategy 2: normalized match (case-insensitive, whitespace-collapsed)
  const normalizedMatch = normalizeText(pred) === normalizeText(goldAnswer);

  // Strategy 3: comparison phrase containment
  // Only applied for ANSWER_TYPE.COMPARISON, matching paper's special-case logic
  let containsMatch = false;
  if (answerType === "ANSWER_TYPE.COMPARISON") {
    const normPred = normalizeText(pred);
    const normGold = normalizeText(goldAnswer);
    for (const phrase of COMPARISON_PHRASES) {
      if (normGold.includes(phrase) && normPred.includes(phrase)) {
        containsMatch = true;
        break;
      }
    }
  }

  // Strategy 4: numeric partial credit (paper uses 0.75^|diff|)
  let numericMatch = false;
  let numericScore = 0;
  if (answerType === "ANSWER_TYPE.NUMERIC") {
    const goldNum = firstNumber(goldAnswer);
    const predNum = firstNumber(pred);
    if (goldNum !== null && predNum !== null) {
      numericScore = Math.pow(0.75, Math.abs(goldNum - predNum));
      numericMatch = numericScore >= 1; // exact numeric match
    }
  }

  // Strategy 5: date comparison
  let dateMatch = false;
  if (answerType === "ANSWER_TYPE.DATE") {
    const goldDate = tryParseDate(goldAnswer);
    const predDate = tryParseDate(pred);
    if (goldDate && predDate) {
      dateMatch =
        goldDate.getFullYear() === predDate.getFullYear() &&
        goldDate.getMonth() === predDate.getMonth() &&
        goldDate.getDate() === predDate.getDate();
    }
  }

  // Compute final score
  let score: number;
  if (exactMatch || normalizedMatch || containsMatch || dateMatch) {
    score = 1;
  } else if (answerType === "ANSWER_TYPE.NUMERIC" && numericScore > 0) {
    score = numericScore;
  } else {
    score = 0;
  }

  const correct = score >= 1;

  return {
    pred,
    gold: goldAnswer,
    score,
    correct,
    exactMatch,
    normalizedMatch,
    containsMatch,
    numericMatch,
  };
}
