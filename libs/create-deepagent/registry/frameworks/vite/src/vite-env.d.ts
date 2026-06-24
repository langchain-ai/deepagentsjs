/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AGENT_API_URL?: string;
  // Exposed to the client via `envPrefix` in vite.config.ts (shared with deploy).
  readonly LANGSMITH_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
