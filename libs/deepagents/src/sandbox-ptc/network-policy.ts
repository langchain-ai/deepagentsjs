/**
 * Network policy enforcement for PTC fetch().
 *
 * Validates URLs against the configured NetworkPolicy, finds the most
 * specific matching rule, merges headers, and enforces response limits.
 */

import type { NetworkPolicy, NetworkRule } from "./types.js";

const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ResolvedRule {
  allowed: true;
  rule: NetworkRule;
  mergedHeaders: Record<string, string>;
  maxResponseBytes: number;
  timeoutMs: number;
}

export interface RejectedRule {
  allowed: false;
  reason: string;
}

export type PolicyResult = ResolvedRule | RejectedRule;

/**
 * Find the matching rule for a URL against the network policy.
 *
 * Matching logic:
 * 1. Parse the URL to extract host and path
 * 2. Check blocked list — if any entry is a prefix of host+path, reject
 * 3. Find the most specific prefix match in allowed
 * 4. Merge defaultHeaders + rule.headers (rule wins on conflict)
 * 5. Resolve timeouts and size limits
 */
export function findMatchingRule(
  url: string,
  method: string,
  policy: NetworkPolicy,
): PolicyResult {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { allowed: false, reason: `Invalid URL: ${url}` };
  }

  const host = parsedUrl.hostname;
  const path = parsedUrl.pathname;
  const hostPath = host + path;

  // 1. Check blocked list (takes precedence)
  if (policy.blocked) {
    for (const blocked of policy.blocked) {
      if (host === blocked || hostPath.startsWith(blocked)) {
        return { allowed: false, reason: `Blocked by policy: ${blocked}` };
      }
    }
  }

  // 2. Find the most specific match in allowed (longest prefix wins)
  let bestMatch: { key: string; rule: NetworkRule } | null = null;

  for (const [key, rule] of Object.entries(policy.allowed)) {
    const slashIdx = key.indexOf("/");
    const ruleHost = slashIdx === -1 ? key : key.slice(0, slashIdx);
    const rulePath = slashIdx === -1 ? "" : key.slice(slashIdx);

    if (host !== ruleHost) continue;

    if (rulePath && !path.startsWith(rulePath)) continue;

    if (!bestMatch || key.length > bestMatch.key.length) {
      bestMatch = { key, rule };
    }
  }

  if (!bestMatch) {
    return {
      allowed: false,
      reason: `Host not in allowed list: ${host}`,
    };
  }

  // 3. Check method restriction
  const allowedMethods = bestMatch.rule.methods;
  if (allowedMethods && !allowedMethods.includes(method.toUpperCase())) {
    return {
      allowed: false,
      reason: `Method ${method.toUpperCase()} not allowed for ${bestMatch.key} (allowed: ${allowedMethods.join(", ")})`,
    };
  }

  // 4. Merge headers: defaults + per-rule (rule wins)
  const mergedHeaders: Record<string, string> = {
    ...(policy.defaultHeaders || {}),
    ...(bestMatch.rule.headers || {}),
  };

  // 5. Resolve limits
  const maxResponseBytes =
    bestMatch.rule.maxResponseBytes ??
    policy.defaultMaxResponseBytes ??
    DEFAULT_MAX_RESPONSE_BYTES;

  const timeoutMs =
    bestMatch.rule.timeoutMs ??
    policy.defaultTimeoutMs ??
    DEFAULT_TIMEOUT_MS;

  return {
    allowed: true,
    rule: bestMatch.rule,
    mergedHeaders,
    maxResponseBytes,
    timeoutMs,
  };
}

/**
 * Execute a policy-enforced fetch request.
 *
 * Applies merged headers, timeout via AbortController, and response
 * size limits. Returns the response body as a string.
 */
export async function policyFetch(
  url: string,
  init: RequestInit | undefined,
  policy: NetworkPolicy,
): Promise<{ ok: boolean; status: number; body: string }> {
  const method = (init?.method || "GET").toUpperCase();
  const result = findMatchingRule(url, method, policy);

  if (!result.allowed) {
    throw new Error(result.reason);
  }

  const { mergedHeaders, maxResponseBytes, timeoutMs } = result;

  // Merge headers from init with policy headers (policy wins)
  const requestHeaders = new Headers(init?.headers);
  for (const [k, v] of Object.entries(mergedHeaders)) {
    requestHeaders.set(k, v);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      method,
      headers: requestHeaders,
      signal: controller.signal,
    });

    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > maxResponseBytes) {
      throw new Error(
        `Response too large: ${contentLength} bytes exceeds limit of ${maxResponseBytes} bytes`,
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return { ok: response.ok, status: response.status, body: "" };
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxResponseBytes) {
        reader.cancel();
        throw new Error(
          `Response too large: exceeded limit of ${maxResponseBytes} bytes`,
        );
      }
      chunks.push(value);
    }

    const body = new TextDecoder().decode(
      chunks.length === 1
        ? chunks[0]
        : new Uint8Array(
            chunks.reduce((acc, c) => {
              const merged = new Uint8Array(acc.byteLength + c.byteLength);
              merged.set(acc);
              merged.set(c, acc.byteLength);
              return merged;
            }),
          ),
    );

    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate a human-readable summary of the network policy for prompts.
 */
export function summarizePolicy(policy: NetworkPolicy): string {
  const allowed = Object.keys(policy.allowed);
  const blocked = policy.blocked || [];

  const lines: string[] = [];
  for (const key of allowed) {
    const rule = policy.allowed[key];
    const extras: string[] = [];
    if (rule.headers) extras.push("custom headers injected");
    if (rule.methods) extras.push(`methods: ${rule.methods.join(", ")}`);
    const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
    const hasPath = key.includes("/");
    lines.push(`- ${key}${hasPath ? "/*" : " (all paths)"}${suffix}`);
  }

  let summary = `\`fetch()\` is available for HTTP requests, restricted to:\n${lines.join("\n")}`;

  if (blocked.length > 0) {
    summary += `\n\nBlocked: ${blocked.join(", ")}`;
  }

  return summary;
}
