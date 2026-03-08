import { describe, it, expect, vi, beforeEach } from "vitest";
import { tool } from "langchain";
import { z } from "zod/v4";
import type {
  SandboxBackendProtocol,
  InteractiveProcess,
  ExecuteResponse,
  FileData,
  WriteResult,
} from "../backends/protocol.js";
import { StdoutScanner, PtcExecutionEngine } from "./engine.js";
import { REQ_LINE_MARKER } from "./runtimes.js";

describe("StdoutScanner", () => {
  let scanner: StdoutScanner;

  beforeEach(() => {
    scanner = new StdoutScanner();
  });

  it("should pass through regular output", () => {
    const events = scanner.processChunk("hello world\n");
    expect(events).toEqual([{ type: "output", text: "hello world\n" }]);
  });

  it("should detect a single-line IPC request", () => {
    const uuid = "test-uuid-123";
    const payload = '{"type":"tool_call","name":"web_search","input":{"query":"test"}}';
    const chunk = `${REQ_LINE_MARKER}${uuid} ${payload}\n`;
    const events = scanner.processChunk(chunk);

    expect(events).toEqual([
      { type: "request", uuid, payload },
    ]);
  });

  it("should handle request split across chunks", () => {
    const uuid = "split-uuid";
    const payload = '{"type":"tool_call","name":"test","input":{}}';

    const events1 = scanner.processChunk(`some output\n${REQ_LINE_MARKER}${uuid} ${payload}`);
    expect(events1).toEqual([
      { type: "output", text: "some output\n" },
    ]);

    const events2 = scanner.processChunk(`\nmore output\n`);
    expect(events2).toEqual([
      { type: "request", uuid, payload },
      { type: "output", text: "more output\n" },
    ]);
  });

  it("should handle partial lines across chunks", () => {
    const events1 = scanner.processChunk("hello ");
    expect(events1).toEqual([]);

    const events2 = scanner.processChunk("world\n");
    expect(events2).toEqual([{ type: "output", text: "hello world\n" }]);
  });

  it("should handle multiple requests in one chunk", () => {
    const req1 = `${REQ_LINE_MARKER}uuid1 {"type":"tool_call","name":"a","input":{}}\n`;
    const req2 = `${REQ_LINE_MARKER}uuid2 {"type":"tool_call","name":"b","input":{}}\n`;

    const events = scanner.processChunk(`output1\n${req1}output2\n${req2}output3\n`);
    expect(events).toEqual([
      { type: "output", text: "output1\n" },
      { type: "request", uuid: "uuid1", payload: '{"type":"tool_call","name":"a","input":{}}' },
      { type: "output", text: "output2\n" },
      { type: "request", uuid: "uuid2", payload: '{"type":"tool_call","name":"b","input":{}}' },
      { type: "output", text: "output3\n" },
    ]);
  });

  it("should flush remaining buffer", () => {
    scanner.processChunk("incomplete");
    expect(scanner.flush()).toBe("incomplete");
  });

  it("should treat malformed marker line as output", () => {
    const events = scanner.processChunk(`${REQ_LINE_MARKER}no-space-here\n`);
    expect(events).toEqual([
      { type: "output", text: `${REQ_LINE_MARKER}no-space-here\n` },
    ]);
  });
});

describe("PtcExecutionEngine", () => {
  function createMockSandbox(opts: {
    stdoutChunks?: string[];
    stderrChunks?: string[];
    writtenFiles?: Map<string, string>;
    exitCode?: number;
  } = {}): SandboxBackendProtocol & { writtenFiles: Map<string, string> } {
    const {
      stdoutChunks = [],
      stderrChunks = [],
      exitCode = 0,
    } = opts;
    const writtenFiles = opts.writtenFiles ?? new Map<string, string>();
    const encoder = new TextEncoder();

    return {
      id: "test-sandbox",
      writtenFiles,
      execute: vi.fn(async (): Promise<ExecuteResponse> => ({
        output: "",
        exitCode: 0,
        truncated: false,
      })),
      lsInfo: async () => [],
      read: async () => "",
      readRaw: async (): Promise<FileData> => ({
        content: [],
        created_at: "",
        modified_at: "",
      }),
      grepRaw: async () => [],
      globInfo: async () => [],
      write: async (_p: string, _c: string): Promise<WriteResult> => ({ path: _p }),
      edit: async () => ({ error: "not implemented" }),
      uploadFiles: vi.fn(async (files: Array<[string, Uint8Array]>) => {
        return files.map(([p]) => ({ path: p, error: null }));
      }),
      downloadFiles: async () => [],

      spawnInteractive: vi.fn(async (): Promise<InteractiveProcess> => ({
        stdout: (async function* () {
          for (const chunk of stdoutChunks) {
            yield encoder.encode(chunk);
          }
        })(),
        stderr: (async function* () {
          for (const chunk of stderrChunks) {
            yield encoder.encode(chunk);
          }
        })(),
        async writeFile(path: string, content: string) {
          writtenFiles.set(path, content);
        },
        async waitForExit() {
          return { exitCode };
        },
        async kill() {},
      })),
    };
  }

  it("should execute a command without IPC requests", async () => {
    const sandbox = createMockSandbox({
      stdoutChunks: ["hello world\n"],
      stderrChunks: [],
      exitCode: 0,
    });

    const engine = new PtcExecutionEngine(sandbox, []);
    const result = await engine.execute("echo hello");

    expect(result.output).toContain("hello world");
    expect(result.exitCode).toBe(0);
    expect(sandbox.spawnInteractive).toHaveBeenCalled();
  });

  it("should process a tool call IPC request", async () => {
    const uuid = "test-uuid-1";
    const payload = '{"type":"tool_call","name":"greet","input":{"name":"Alice"}}';
    const stderrChunks = [
      `${REQ_LINE_MARKER}${uuid} ${payload}\n`,
    ];
    const stdoutChunks = ["before\nafter\n"];

    const writtenFiles = new Map<string, string>();
    const sandbox = createMockSandbox({ stdoutChunks, stderrChunks, writtenFiles });

    const greetTool = tool(
      async (input: { name: string }) => `Hello, ${input.name}!`,
      {
        name: "greet",
        description: "Greet someone",
        schema: z.object({ name: z.string() }),
      },
    );

    const engine = new PtcExecutionEngine(sandbox, [greetTool]);
    const result = await engine.execute("echo before && echo after");

    expect(result.output).toContain("before");
    expect(result.output).toContain("after");
    expect(result.output).not.toContain(REQ_LINE_MARKER);

    const responsePath = `/tmp/.da_ipc/res/${uuid}`;
    expect(writtenFiles.has(responsePath)).toBe(true);
    const response = writtenFiles.get(responsePath)!;
    expect(response).toMatch(/^0\n/);
    expect(response).toContain("Hello, Alice!");
  });

  it("should handle tool call errors gracefully", async () => {
    const uuid = "error-uuid";
    const payload = '{"type":"tool_call","name":"fail","input":{}}';
    const stderrChunks = [
      `${REQ_LINE_MARKER}${uuid} ${payload}\n`,
    ];

    const writtenFiles = new Map<string, string>();
    const sandbox = createMockSandbox({ stderrChunks, writtenFiles });

    const failTool = tool(
      async () => {
        throw new Error("Tool failed intentionally");
      },
      {
        name: "fail",
        description: "Always fails",
        schema: z.object({}),
      },
    );

    const engine = new PtcExecutionEngine(sandbox, [failTool]);
    await engine.execute("test");

    const responsePath = `/tmp/.da_ipc/res/${uuid}`;
    const response = writtenFiles.get(responsePath)!;
    expect(response).toMatch(/^1\n/);
    expect(response).toContain("Tool failed intentionally");
  });

  it("should handle unknown tool names", async () => {
    const uuid = "unknown-uuid";
    const payload = '{"type":"tool_call","name":"nonexistent","input":{}}';
    const stderrChunks = [
      `${REQ_LINE_MARKER}${uuid} ${payload}\n`,
    ];

    const writtenFiles = new Map<string, string>();
    const sandbox = createMockSandbox({ stderrChunks, writtenFiles });

    const engine = new PtcExecutionEngine(sandbox, []);
    await engine.execute("test");

    const responsePath = `/tmp/.da_ipc/res/${uuid}`;
    const response = writtenFiles.get(responsePath)!;
    expect(response).toMatch(/^1\n/);
    expect(response).toContain("Unknown tool: nonexistent");
  });

  it("should throw when sandbox does not support spawnInteractive", async () => {
    const sandbox = createMockSandbox();
    delete (sandbox as any).spawnInteractive;

    const engine = new PtcExecutionEngine(sandbox, []);
    await expect(engine.execute("test")).rejects.toThrow("spawnInteractive");
  });

  it("should handle concurrent tool calls", async () => {
    const payload1 = '{"type":"tool_call","name":"echo","input":{"msg":"one"}}';
    const payload2 = '{"type":"tool_call","name":"echo","input":{"msg":"two"}}';
    const stderrChunks = [
      `${REQ_LINE_MARKER}uuid-1 ${payload1}\n`,
      `${REQ_LINE_MARKER}uuid-2 ${payload2}\n`,
    ];

    const writtenFiles = new Map<string, string>();
    const sandbox = createMockSandbox({ stderrChunks, writtenFiles });

    const echoTool = tool(
      async (input: { msg: string }) => input.msg,
      {
        name: "echo",
        description: "Echo a message",
        schema: z.object({ msg: z.string() }),
      },
    );

    const engine = new PtcExecutionEngine(sandbox, [echoTool]);
    await engine.execute("test");

    expect(writtenFiles.has("/tmp/.da_ipc/res/uuid-1")).toBe(true);
    expect(writtenFiles.has("/tmp/.da_ipc/res/uuid-2")).toBe(true);
    expect(writtenFiles.get("/tmp/.da_ipc/res/uuid-1")).toBe("0\none");
    expect(writtenFiles.get("/tmp/.da_ipc/res/uuid-2")).toBe("0\ntwo");
  });

  it("should collect non-marker stderr output", async () => {
    const sandbox = createMockSandbox({
      stdoutChunks: ["stdout\n"],
      stderrChunks: ["stderr line\n"],
    });

    const engine = new PtcExecutionEngine(sandbox, []);
    const result = await engine.execute("test");

    expect(result.output).toContain("stdout");
    expect(result.output).toContain("stderr line");
  });

  it("should install runtime libraries via execute() on first run", async () => {
    const sandbox = createMockSandbox({ stdoutChunks: ["ok\n"] });

    const engine = new PtcExecutionEngine(sandbox, []);
    await engine.execute("test");

    // 3 execute() calls for runtime install + 1 spawnInteractive for the command
    const executeCalls = (sandbox.execute as any).mock.calls as Array<[string]>;
    expect(executeCalls.length).toBe(3);
    expect(executeCalls.some(([cmd]: [string]) => cmd.includes("da_runtime.sh"))).toBe(true);
    expect(executeCalls.some(([cmd]: [string]) => cmd.includes("da_runtime.py"))).toBe(true);
    expect(executeCalls.some(([cmd]: [string]) => cmd.includes("da_runtime.js"))).toBe(true);
  });

  it("should not re-install runtime libraries on subsequent executions", async () => {
    const sandbox = createMockSandbox({ stdoutChunks: ["ok\n"] });

    const engine = new PtcExecutionEngine(sandbox, []);
    await engine.execute("test1");
    await engine.execute("test2");

    // 3 execute() calls for runtime install (only first time)
    // spawnInteractive is called twice (once per execute)
    expect(sandbox.execute).toHaveBeenCalledTimes(3);
    expect(sandbox.spawnInteractive).toHaveBeenCalledTimes(2);
  });
});
