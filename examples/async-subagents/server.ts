import { Hono } from "hono";
import { agent } from "./agent.js";

export const api = new Hono();

api.post("/api/stream", async (c) => {
  const { input, config } = await c.req.json();

  const stream = await agent.stream(input ?? { messages: [], tasks: {} }, {
    ...config,
    encoding: "text/event-stream" as const,
    streamMode: ["updates", "messages", "values"] as const,
    subgraphs: true,
    recursionLimit: 150,
  });

  return new Response(stream as unknown as ReadableStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))
) {
  const { serve } = await import("@hono/node-server");
  const port = 3001;
  console.log(`Server listening on http://localhost:${port}`);
  serve({ fetch: api.fetch, port });
}
