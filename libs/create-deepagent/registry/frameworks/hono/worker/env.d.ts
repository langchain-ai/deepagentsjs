/// <reference types="@cloudflare/workers-types" />

import type { Command, CommandResponse, ErrorResponse } from "@langchain/protocol";

declare global {
  interface Env {
    ASSETS: Fetcher;
    SESSIONS: DurableObjectNamespace;
    OPENAI_API_KEY?: string;
  }
}

export type { Command, CommandResponse, ErrorResponse };
