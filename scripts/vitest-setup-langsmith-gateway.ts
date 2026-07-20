/**
 * Route integration-test LLM calls through the LangSmith LLM Gateway.
 *
 * When `LANGSMITH_GATEWAY_KEY` (or `LC_GATEWAY_KEY`) is set, provider SDKs are
 * pointed at `https://gateway.smith.langchain.com` and authenticate with that
 * key. Provider secrets stay in LangSmith; local `ANTHROPIC_API_KEY` /
 * `OPENAI_API_KEY` values are overridden for the test process.
 *
 * @see https://docs.langchain.com/langsmith/llm-gateway-quickstart
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_GATEWAY_BASE_URL = "https://gateway.smith.langchain.com";

/** Load repo-root `.env` without overriding vars already present in the process. */
function loadRootEnv(): void {
  const rootEnv = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.env",
  );
  if (!fs.existsSync(rootEnv)) {
    return;
  }

  for (const rawLine of fs.readFileSync(rootEnv, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    if (process.env[key] !== undefined) {
      continue;
    }
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/**
 * Configure process.env so Anthropic/OpenAI/Gemini/etc. clients use the gateway.
 * No-op when no gateway key is present (keeps direct-provider local/CI fallbacks).
 */
export function configureLangSmithGateway(): boolean {
  const gatewayKey =
    process.env.LANGSMITH_GATEWAY_KEY?.trim() ||
    process.env.LC_GATEWAY_KEY?.trim();

  if (!gatewayKey) {
    return false;
  }

  const baseUrl = (
    process.env.LANGSMITH_GATEWAY_BASE_URL?.trim() || DEFAULT_GATEWAY_BASE_URL
  ).replace(/\/+$/, "");

  process.env.ANTHROPIC_BASE_URL = `${baseUrl}/anthropic`;
  process.env.OPENAI_BASE_URL = `${baseUrl}/openai/v1`;
  process.env.GOOGLE_GEMINI_BASE_URL = `${baseUrl}/gemini`;
  process.env.FIREWORKS_BASE_URL = `${baseUrl}/fireworks`;
  process.env.BASETEN_BASE_URL = `${baseUrl}/baseten/v1`;

  // Gateway auth: LangSmith API key stands in for every provider SDK key.
  process.env.ANTHROPIC_API_KEY = gatewayKey;
  process.env.OPENAI_API_KEY = gatewayKey;
  process.env.GEMINI_API_KEY = gatewayKey;
  process.env.GOOGLE_API_KEY = gatewayKey;
  process.env.FIREWORKS_API_KEY = gatewayKey;
  process.env.BASETEN_API_KEY = gatewayKey;

  // Anthropic SDK also honors this for proxy setups (matches org MDM/Kandji env).
  process.env.ANTHROPIC_CUSTOM_HEADERS = `X-Api-Key: ${gatewayKey}`;

  return true;
}

loadRootEnv();
configureLangSmithGateway();
