/**
 * WASIX Attach Client
 *
 * Connects to a running WASIX daemon's Unix socket and provides
 * an interactive terminal session.
 *
 * Usage: pnpm run demo:attach
 */

import net from "node:net";
import fs from "node:fs";

const SOCKET_PATH = "/tmp/wasix-session.sock";

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function cleanup(): void {
  process.stdin.pause();
}

// Check if socket exists before attempting connection
if (!fs.existsSync(SOCKET_PATH)) {
  die("No running WASIX daemon found. Start one with: pnpm run demo:start");
}

const socket = net.createConnection(SOCKET_PATH);
let connected = false;

socket.on("connect", () => {
  connected = true;
  console.log("[attached]");

  // Use line-buffered mode (no raw mode) so the terminal handles
  // echo and line editing natively. Bash in WASIX has no PTY layer,
  // so it won't echo input — letting the terminal do it avoids the problem.
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  // Forward input to the daemon
  process.stdin.on("data", (chunk) => {
    socket.write(chunk);
  });

  // Handle stdin end (Ctrl+D)
  process.stdin.on("end", () => {
    socket.end();
  });

  // Receive output from the daemon
  let firstChunk = true;
  socket.on("data", (chunk: Buffer) => {
    if (firstChunk) {
      firstChunk = false;
      const text = chunk.toString();
      if (text.startsWith("ERROR:")) {
        cleanup();
        die(text.trim());
      }
    }
    process.stdout.write(chunk);
  });
});

socket.on("close", () => {
  cleanup();
  if (connected) {
    console.log("\n[detached]");
  }
  process.exit(0);
});

socket.on("error", (err: NodeJS.ErrnoException) => {
  cleanup();
  if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
    die("No running WASIX daemon found. Start one with: pnpm run demo:start");
  }
  die(`Connection error: ${err.message}`);
});

// Handle SIGINT — restore terminal before exiting
process.on("SIGINT", () => {
  cleanup();
  socket.destroy();
  process.exit(0);
});
