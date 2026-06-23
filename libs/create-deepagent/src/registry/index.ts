export {
  createProvider,
  type ProviderConfig,
  type EnvVarSpec,
} from "./provider.js";
export {
  createFramework,
  type FrameworkConfig,
  type ProviderAwareFile,
} from "./framework.js";

import { openai } from "../../registry/providers/openai.js";
import { anthropic } from "../../registry/providers/anthropic.js";
import { google } from "../../registry/providers/google.js";
import { fireworks } from "../../registry/providers/fireworks.js";

import { next } from "../../registry/frameworks/next.js";
import { nuxt } from "../../registry/frameworks/nuxt.js";
import { hono } from "../../registry/frameworks/hono.js";
import { deno } from "../../registry/frameworks/deno.js";
import { vite } from "../../registry/frameworks/vite.js";

export const providers = {
  [openai.id]: openai,
  [anthropic.id]: anthropic,
  [google.id]: google,
  [fireworks.id]: fireworks,
} as const;
export type ProviderKey = keyof typeof providers;

export const frameworks = {
  [next.id]: next,
  [nuxt.id]: nuxt,
  [hono.id]: hono,
  [vite.id]: vite,
  [deno.id]: deno,
} as const;
export type FrameworkKey = keyof typeof frameworks;
