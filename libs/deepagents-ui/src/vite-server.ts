import { createServer as createHttpServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { ACPAttachedSession } from "deepagents";
import { createServer as createViteServer } from "vite";

import type { WebUIRuntimeOptions } from "./types.js";

function readJsonBody(req: import("node:http").IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function resolveClientRoot(): Promise<string> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, "client"),
    path.join(moduleDir, "..", "src", "client"),
  ];

  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, "index.html"));
      return candidate;
    } catch {
      // Try the next possible layout.
    }
  }

  throw new Error(
    `Unable to locate DeepAgents UI client assets. Checked: ${candidates.join(", ")}`,
  );
}

export async function startViteWebUIServer(args: {
  attached: ACPAttachedSession;
  options?: WebUIRuntimeOptions;
}) {
  const { attached, options } = args;
  const clientRoot = await resolveClientRoot();
  const host = options?.host ?? "127.0.0.1";
  const port = options?.port ?? 3000;

  const vite = await createViteServer({
    root: clientRoot,
    server: { middlewareMode: true },
    appType: "custom",
  });

  const server = createHttpServer(async (req, res) => {
    if (!req.url) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const url = new URL(req.url, `http://${host}:${port}`);

    if (req.method === "GET" && url.pathname === "/api/initial") {
      const updates = await attached.getInitialUpdates();
      sendJson(res, 200, { updates, client: attached.client });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/updates") {
      const page = await attached.poll({
        after: url.searchParams.get("after") ?? undefined,
        limit: url.searchParams.get("limit")
          ? Number(url.searchParams.get("limit"))
          : undefined,
        threadId: url.searchParams.get("threadId") ?? undefined,
      });
      sendJson(res, 200, page);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/steer") {
      try {
        const input = await readJsonBody(req);
        const result = await attached.steer(input);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      sendJson(res, 200, {
        allowSteering: options?.allowSteering ?? false,
        pollIntervalMs: options?.pollIntervalMs ?? 1000,
      });
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const indexPath = path.join(clientRoot, "index.html");
      const template = await readFile(indexPath, "utf8");
      const html = await vite.transformIndexHtml(url.pathname, template);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html");
      res.end(html);
      return;
    }

    vite.middlewares(req, res, () => {
      res.statusCode = 404;
      res.end("Not found");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  return {
    url: `http://${host}:${port}`,
    async stop() {
      await vite.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
