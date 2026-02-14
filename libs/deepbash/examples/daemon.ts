/**
 * WASIX Daemon Process
 *
 * Boots the WASIX sandbox, exposes a Unix domain socket for shell attach,
 * and monitors for subagent spawn events.
 *
 * Usage: pnpm run demo:start
 */

import net from "node:net";
import fs from "node:fs";
import { DeepbashBackend } from "../src/backend.js";

const SOCKET_PATH = `/tmp/wasix-${process.pid}.sock`;
const WELL_KNOWN_SOCKET = `/tmp/wasix-session.sock`;

// --- Lifecycle logging ---

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[${ts}] ${msg}\n`);
}

// --- Spawn event detection ---

let lineBuf = "";

function checkForSpawnEvents(text: string): void {
  lineBuf += text;
  const lines = lineBuf.split("\n");
  // Keep the last (possibly incomplete) line in the buffer
  lineBuf = lines.pop() ?? "";

  for (const line of lines) {
    const match = line.match(/Spawn request (\S+) submitted/);
    if (match) {
      const id = match[1];
      log(`┌─ [subagent] spawn request detected`);
      log(`│  id: ${id}`);
      log(`└─ (fire-and-forget)`);
    }
  }
}

// --- Stream pump ---

/**
 * Pump a Web ReadableStream to the daemon stdout and the attached client.
 * For the stdout stream, also watches for subagent spawn markers.
 */
async function pumpStream(
  stream: ReadableStream,
  label: string,
  getClient: () => net.Socket | null,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      // Write raw bytes to daemon stdout
      process.stdout.write(value);

      // Forward to attached client (if any)
      const client = getClient();
      if (client && !client.destroyed) {
        client.write(Buffer.from(value));
      }

      // Check for subagent spawn markers on stdout only
      if (label === "stdout") {
        const text = decoder.decode(value, { stream: true });
        checkForSpawnEvents(text);
      }
    }
  } catch (err) {
    // Stream closed or errored — expected during shutdown
    if (
      err instanceof Error &&
      !err.message.includes("released") &&
      !err.message.includes("cancel")
    ) {
      log(`[${label}] stream error: ${err}`);
    }
  }
}

// --- Cleanup ---

function cleanupFiles(): void {
  for (const p of [SOCKET_PATH, WELL_KNOWN_SOCKET]) {
    try {
      fs.unlinkSync(p);
    } catch {
      // Already cleaned up or never created
    }
  }
}

// --- Main ---

async function main(): Promise<void> {
  log("Booting WASIX sandbox...");

  const backend = await DeepbashBackend.create();
  const session = await backend.shell();

  log(`WASIX sandbox ready. Socket: ${SOCKET_PATH}`);

  // Clean up stale socket files from a previous crash
  cleanupFiles();

  // Create symlink at well-known path
  fs.symlinkSync(SOCKET_PATH, WELL_KNOWN_SOCKET);

  // Track the single attached client
  let attachedClient: net.Socket | null = null;

  function getAttachedClient(): net.Socket | null {
    return attachedClient;
  }

  // Create Unix domain socket server
  const server = net.createServer((socket) => {
    if (attachedClient !== null) {
      socket.write("ERROR: Another client is already attached.\n");
      socket.destroy();
      return;
    }

    attachedClient = socket;
    log("[attached] client connected");

    // Client → shell stdin
    socket.on("data", (chunk: Buffer) => {
      const writer = session.stdin.getWriter();
      writer.write(new Uint8Array(chunk)).then(
        () => writer.releaseLock(),
        () => writer.releaseLock(),
      );
    });

    socket.on("close", () => {
      attachedClient = null;
      log("[detached] client disconnected");
    });

    socket.on("error", () => {
      attachedClient = null;
      log("[detached] client disconnected (error)");
    });
  });

  // Register signal handlers before blocking on session.wait()
  const shutdown = () => {
    log("Shutting down...");
    session.kill();
    server.close();
    backend.close();
    cleanupFiles();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.listen(SOCKET_PATH, () => {
    log(`Listening on ${SOCKET_PATH}`);
    log(`Symlinked to ${WELL_KNOWN_SOCKET}`);
    log("Waiting for attach...");
  });

  // Start pumping shell output (runs in background)
  pumpStream(session.stdout, "stdout", getAttachedClient);
  pumpStream(session.stderr, "stderr", getAttachedClient);

  // Block until the shell exits
  const { exitCode } = await session.wait();
  log(`Shell exited with code ${exitCode}`);

  server.close();
  backend.close();
  cleanupFiles();
  process.exit(exitCode);
}

// --- Entrypoint ---

main().catch((err) => {
  console.error("Fatal:", err);
  cleanupFiles();
  process.exit(1);
});
