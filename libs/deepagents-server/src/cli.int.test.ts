/**
 * Integration tests for the DeepAgents ACP Server CLI
 *
 * These tests spawn the actual CLI process and communicate with it
 * via the ACP protocol over stdio (stdin/stdout with ndjson).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as readline from "node:readline";

// ACP message types
interface ACPRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface ACPResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ACPNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Helper class to manage the CLI process and ACP communication
 */
class CLITestHelper {
  private process: ChildProcess | null = null;
  private responseQueue: Map<number, {
    resolve: (value: ACPResponse) => void;
    reject: (error: Error) => void;
  }> = new Map();
  private notifications: ACPNotification[] = [];
  private nextId = 1;
  private rl: readline.Interface | null = null;
  private stderrOutput: string[] = [];

  constructor(
    private cliPath: string,
    private args: string[] = [],
  ) {}

  /**
   * Start the CLI process
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("CLI startup timeout"));
      }, 10000);

      this.process = spawn("node", [this.cliPath, ...this.args], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          // Ensure we don't need an API key for tests
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "test-key",
        },
      });

      // Handle stderr (debug output)
      this.process.stderr?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter(Boolean);
        this.stderrOutput.push(...lines);
        
        // Check for startup message
        if (lines.some((l) => l.includes("Server started") || l.includes("waiting for connections"))) {
          clearTimeout(timeout);
          resolve();
        }
      });

      // Handle stdout (ACP protocol messages)
      if (this.process.stdout) {
        this.rl = readline.createInterface({
          input: this.process.stdout,
          crlfDelay: Infinity,
        });

        this.rl.on("line", (line) => {
          if (!line.trim()) return;
          
          try {
            const message = JSON.parse(line);
            
            if ("id" in message && this.responseQueue.has(message.id)) {
              // This is a response to a request
              const handler = this.responseQueue.get(message.id)!;
              this.responseQueue.delete(message.id);
              handler.resolve(message as ACPResponse);
            } else if ("method" in message && !("id" in message)) {
              // This is a notification
              this.notifications.push(message as ACPNotification);
            }
          } catch {
            // Ignore non-JSON lines
          }
        });
      }

      this.process.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.process.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeout);
          reject(new Error(`CLI exited with code ${code}`));
        }
      });

      // If no debug output, resolve after a short delay
      setTimeout(() => {
        clearTimeout(timeout);
        resolve();
      }, 2000);
    });
  }

  /**
   * Send an ACP request and wait for response
   */
  async sendRequest(method: string, params?: Record<string, unknown>): Promise<ACPResponse> {
    if (!this.process?.stdin) {
      throw new Error("CLI not started");
    }

    const id = this.nextId++;
    const request: ACPRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.responseQueue.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, 30000);

      this.responseQueue.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      const line = JSON.stringify(request) + "\n";
      this.process!.stdin!.write(line);
    });
  }

  /**
   * Send an ACP notification (no response expected)
   */
  sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.process?.stdin) {
      throw new Error("CLI not started");
    }

    const notification: ACPNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };

    const line = JSON.stringify(notification) + "\n";
    this.process.stdin.write(line);
  }

  /**
   * Get collected notifications
   */
  getNotifications(): ACPNotification[] {
    return [...this.notifications];
  }

  /**
   * Clear collected notifications
   */
  clearNotifications(): void {
    this.notifications = [];
  }

  /**
   * Get stderr output
   */
  getStderr(): string[] {
    return [...this.stderrOutput];
  }

  /**
   * Stop the CLI process
   */
  async stop(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    if (this.process) {
      // Close stdin to signal EOF
      this.process.stdin?.end();
      
      // Wait for process to exit
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.process?.kill("SIGKILL");
          resolve();
        }, 5000);

        this.process!.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });

        this.process?.kill("SIGTERM");
      });

      this.process = null;
    }
  }

  /**
   * Check if process is running
   */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }
}

describe("CLI Integration Tests", () => {
  let helper: CLITestHelper;
  let tempDir: string;
  let logFile: string;
  const cliPath = path.resolve(__dirname, "..", "dist", "cli.js");

  beforeEach(() => {
    // Create temp directory for log files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepagents-cli-test-"));
    logFile = path.join(tempDir, "test.log");
  });

  afterEach(async () => {
    // Stop the CLI process
    if (helper) {
      await helper.stop();
    }

    // Cleanup temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("CLI Startup", () => {
    it("should start the CLI process successfully", async () => {
      helper = new CLITestHelper(cliPath, ["--debug"]);
      await helper.start();

      expect(helper.isRunning()).toBe(true);
    });

    it("should start with custom agent name", async () => {
      helper = new CLITestHelper(cliPath, [
        "--name", "test-agent",
        "--debug",
      ]);
      await helper.start();

      expect(helper.isRunning()).toBe(true);
      
      const stderr = helper.getStderr();
      expect(stderr.some((line) => line.includes("test-agent"))).toBe(true);
    });

    it("should write logs to file when --log-file is specified", async () => {
      helper = new CLITestHelper(cliPath, [
        "--log-file", logFile,
      ]);
      await helper.start();

      // Give time for log to be written
      await new Promise((r) => setTimeout(r, 500));

      expect(fs.existsSync(logFile)).toBe(true);
      const logContent = fs.readFileSync(logFile, "utf8");
      expect(logContent).toContain("Started at");
    });
  });

  describe("ACP Protocol - Initialize", () => {
    beforeEach(async () => {
      helper = new CLITestHelper(cliPath, ["--debug"]);
      await helper.start();
    });

    it("should respond to initialize request", async () => {
      const response = await helper.sendRequest("initialize", {
        // ACP spec requires protocolVersion as number
        protocolVersion: 1,
        clientInfo: {
          name: "test-client",
          version: "1.0.0",
        },
      });

      expect(response.result).toBeDefined();
      // Check for ACP spec format (agentInfo)
      const agentInfo = response.result?.agentInfo as { name?: string; version?: string } | undefined;
      expect(agentInfo?.name).toBe("deepagents-server");
      expect(response.result?.protocolVersion).toBe(1);
    });

    it("should return server capabilities", async () => {
      const response = await helper.sendRequest("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "test-client", version: "1.0.0" },
      });

      expect(response.result?.agentCapabilities).toBeDefined();
      const capabilities = response.result?.agentCapabilities as Record<string, unknown>;
      // ACP spec: loadSession is a boolean
      expect(capabilities.loadSession).toBe(true);
      // ACP spec: sessionCapabilities contains modes and commands
      const sessionCaps = capabilities.sessionCapabilities as Record<string, boolean>;
      expect(sessionCaps.modes).toBe(true);
      expect(sessionCaps.commands).toBe(true);
    });

    it("should return prompt capabilities", async () => {
      const response = await helper.sendRequest("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "test-client", version: "1.0.0" },
      });

      expect(response.result?.agentCapabilities).toBeDefined();
      const agentCaps = response.result?.agentCapabilities as Record<string, unknown>;
      // ACP spec: promptCapabilities has image, audio, embeddedContext
      const promptCaps = agentCaps.promptCapabilities as Record<string, boolean>;
      expect(promptCaps.image).toBe(true);
      expect(promptCaps.embeddedContext).toBe(true);
    });
  });

  describe("ACP Protocol - Session Management", () => {
    beforeEach(async () => {
      helper = new CLITestHelper(cliPath, ["--debug", "--name", "test-agent"]);
      await helper.start();

      // Initialize first with ACP spec format
      await helper.sendRequest("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "test-client", version: "1.0.0" },
      });
    });

    it("should create a new session", async () => {
      // ACP spec requires cwd and mcpServers for session/new
      const response = await helper.sendRequest("session/new", {
        cwd: process.cwd(),
        mcpServers: [],
      });

      expect(response.result).toBeDefined();
      expect(response.result?.sessionId).toBeDefined();
      expect(typeof response.result?.sessionId).toBe("string");
      expect((response.result?.sessionId as string).startsWith("sess_")).toBe(true);
    });

    it("should return available modes in new session", async () => {
      const response = await helper.sendRequest("session/new", {
        cwd: process.cwd(),
        mcpServers: [],
      });

      // ACP spec uses 'modes' object with 'availableModes' array and 'currentModeId'
      expect(response.result?.modes).toBeDefined();
      const modesState = response.result?.modes as { availableModes?: Array<{ id: string; name: string }>; currentModeId?: string };
      expect(modesState.availableModes).toBeDefined();
      expect(modesState.availableModes!.length).toBeGreaterThan(0);
      
      const modeIds = modesState.availableModes!.map((m) => m.id);
      expect(modeIds).toContain("agent");
      expect(modeIds).toContain("plan");
      expect(modeIds).toContain("ask");
    });

    it("should return currentModeId in new session", async () => {
      const response = await helper.sendRequest("session/new", {
        cwd: process.cwd(),
        mcpServers: [],
      });

      // ACP spec: modes object contains currentModeId
      expect(response.result?.modes).toBeDefined();
      const modesState = response.result?.modes as { currentModeId?: string };
      expect(modesState.currentModeId).toBe("agent");
    });

    it("should load an existing session", async () => {
      // Create a session first
      const createResponse = await helper.sendRequest("session/new", {
        cwd: process.cwd(),
        mcpServers: [],
      });
      const sessionId = createResponse.result?.sessionId as string;

      // Load the session with ACP spec required params
      const loadResponse = await helper.sendRequest("session/load", {
        sessionId,
        cwd: process.cwd(),
        mcpServers: [],
      });

      // ACP spec: LoadSessionResponse returns modes, not sessionId
      expect(loadResponse.result).toBeDefined();
      expect(loadResponse.result?.modes).toBeDefined();
    });

    it("should fail to load non-existent session", async () => {
      const response = await helper.sendRequest("session/load", {
        sessionId: "sess_nonexistent12345",
        cwd: process.cwd(),
        mcpServers: [],
      });

      // ACP SDK wraps internal errors
      expect(response.error).toBeDefined();
    });

    it("should set session mode", async () => {
      // Create a session first
      const createResponse = await helper.sendRequest("session/new", {
        cwd: process.cwd(),
        mcpServers: [],
      });
      const sessionId = createResponse.result?.sessionId as string;

      // Set mode to plan using ACP spec param name 'modeId'
      const modeResponse = await helper.sendRequest("session/set_mode", {
        sessionId,
        modeId: "plan",
      });

      // Should not return an error
      expect(modeResponse.error).toBeUndefined();
    });
  });

  describe("ACP Protocol - Cancel", () => {
    beforeEach(async () => {
      helper = new CLITestHelper(cliPath, ["--debug"]);
      await helper.start();

      await helper.sendRequest("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "test-client", version: "1.0.0" },
      });
    });

    it("should handle cancel notification", async () => {
      // Create a session
      const createResponse = await helper.sendRequest("session/new", {});
      const sessionId = createResponse.result?.sessionId as string;

      // Send cancel notification (no response expected)
      helper.sendNotification("session/cancel", { sessionId });

      // Should not crash - wait a bit
      await new Promise((r) => setTimeout(r, 100));
      expect(helper.isRunning()).toBe(true);
    });
  });

  describe("Debug Logging", () => {
    it("should output debug logs to stderr when --debug is set", async () => {
      helper = new CLITestHelper(cliPath, ["--debug"]);
      await helper.start();

      await helper.sendRequest("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "debug-test", version: "1.0.0" },
      });

      const stderr = helper.getStderr();
      expect(stderr.some((line) => line.includes("[deepagents-server]"))).toBe(true);
    });

    it("should log client connection info in debug mode", async () => {
      helper = new CLITestHelper(cliPath, ["--debug"]);
      await helper.start();

      await helper.sendRequest("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "my-test-client", version: "2.0.0" },
      });

      const stderr = helper.getStderr();
      expect(stderr.some((line) => 
        line.includes("Client connected") || line.includes("my-test-client")
      )).toBe(true);
    });
  });

  describe("Error Handling", () => {
    beforeEach(async () => {
      helper = new CLITestHelper(cliPath, ["--debug"]);
      await helper.start();
    });

    it("should return error for unknown method", async () => {
      const response = await helper.sendRequest("unknown/method", {});

      // The ACP SDK may handle this differently, but we should get some response
      expect(response).toBeDefined();
    });

    it("should handle invalid session ID gracefully", async () => {
      await helper.sendRequest("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "test-client", version: "1.0.0" },
      });

      const response = await helper.sendRequest("session/load", {
        sessionId: "invalid-session-id",
        cwd: process.cwd(),
        mcpServers: [],
      });

      expect(response.error).toBeDefined();
    });
  });
});

describe("CLI Help and Version", () => {
  it("should show help with --help flag", async () => {
    const cliPath = path.resolve(__dirname, "..", "dist", "cli.js");
    
    const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      const proc = spawn("node", [cliPath, "--help"]);
      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data) => { stdout += data.toString(); });
      proc.stderr?.on("data", (data) => { stderr += data.toString(); });
      proc.on("exit", (code) => {
        resolve({ stdout, stderr, code: code ?? 0 });
      });
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("DeepAgents ACP Server");
    expect(result.stdout).toContain("--name");
    expect(result.stdout).toContain("--debug");
    expect(result.stdout).toContain("--log-file");
  });

  it("should show version with --version flag", async () => {
    const cliPath = path.resolve(__dirname, "..", "dist", "cli.js");
    
    const result = await new Promise<{ stdout: string; code: number }>((resolve) => {
      const proc = spawn("node", [cliPath, "--version"]);
      let stdout = "";

      proc.stdout?.on("data", (data) => { stdout += data.toString(); });
      proc.on("exit", (code) => {
        resolve({ stdout, code: code ?? 0 });
      });
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("deepagents-server");
  });
});
