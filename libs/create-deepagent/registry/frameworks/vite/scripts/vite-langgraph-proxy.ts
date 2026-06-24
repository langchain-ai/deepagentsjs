import type { ProxyOptions } from "vite";

const LANGGRAPH_UPSTREAM =
  process.env.LANGGRAPH_PROXY_TARGET ?? "http://127.0.0.1:2025";

const UPSTREAM_PROXY: Omit<ProxyOptions, "rewrite"> = {
  target: LANGGRAPH_UPSTREAM,
  changeOrigin: true,
  timeout: 600_000,
  proxyTimeout: 600_000,
};

/**
 * Vite dev-server proxy rules for LangGraph API traffic.
 *
 * Clients use `apiUrl = origin + "/api/langgraph"`. The LangGraph SDK may
 * also resolve paths like `/threads/...` from the dev-server root, so mirror
 * allowlisted upstream routes at both locations.
 */
export function createLangGraphViteProxy(): Record<string, ProxyOptions> {
  return {
    "/api/langgraph": {
      ...UPSTREAM_PROXY,
      rewrite: (path) => path.replace(/^\/api\/langgraph/, ""),
    },
    "/threads": UPSTREAM_PROXY,
    "/runs": UPSTREAM_PROXY,
    "/assistants": UPSTREAM_PROXY,
    "/sandbox": UPSTREAM_PROXY,
    "/download": UPSTREAM_PROXY,
    "/ok": UPSTREAM_PROXY,
    "/info": UPSTREAM_PROXY,
  };
}
