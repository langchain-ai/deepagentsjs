/**
 * Deno Deploy entrypoint.
 *
 * Serves the Agent Streaming Protocol under `/api/threads/...` and the Vite-
 * built React SPA from `dist/` for all other routes.
 */

import { Hono } from "hono";
import { serveStatic } from "hono/deno";

import { api } from "./server/routes.ts";

const app = new Hono();

app.route("/api", api);

app.use(serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ path: "./dist/index.html" }));

const port = Number(Deno.env.get("PORT") ?? 8000);
console.log(`Listening on http://localhost:${port}`);

Deno.serve({ port }, app.fetch);
