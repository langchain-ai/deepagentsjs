import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { Readable } from "node:stream";
import { api } from "./server.js";

function honoDevServer(): Plugin {
  return {
    name: "hono-dev-server",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api")) return next();

        const url = new URL(req.url, `http://${req.headers.host}`);
        const headers = new Headers();
        for (const [key, val] of Object.entries(req.headers)) {
          if (val) headers.set(key, Array.isArray(val) ? val.join(", ") : val);
        }

        let body: Buffer | undefined;
        if (req.method !== "GET" && req.method !== "HEAD") {
          body = await new Promise<Buffer>((resolve) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => resolve(Buffer.concat(chunks)));
          });
        }

        const webReq = new Request(url, {
          method: req.method,
          headers,
          body: body as BodyInit | undefined,
        });

        const webRes = await api.fetch(webReq);

        res.statusCode = webRes.status;
        webRes.headers.forEach((v, k) => res.setHeader(k, v));

        if (webRes.body) {
          Readable.fromWeb(webRes.body as never).pipe(res);
        } else {
          res.end();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), honoDevServer()],
});
