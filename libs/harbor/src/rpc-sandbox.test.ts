import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInterface } from "readline";
import { Readable } from "stream";

import { RpcSandbox } from "./rpc-sandbox.js";
import { resetRequestCounter } from "./rpc-protocol.js";

/**
 * Helper to create an RpcSandbox with a mock stdin that we can write to.
 * We create a readable stream that we can push data into, and wrap it
 * with readline for the sandbox to consume.
 */
function createTestSandbox(sessionId = "test-session") {
  const inputStream = new Readable({
    read() {
      // no-op: we push data manually
    },
  });

  const reader = createInterface({
    input: inputStream,
    crlfDelay: Infinity,
  });

  const sandbox = new RpcSandbox(sessionId, reader);

  // Capture stdout writes (outgoing messages)
  const writtenMessages: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const mockWrite = vi
    .fn()
    .mockImplementation(
      (
        chunk: string | Uint8Array,
        _encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
        _cb?: (error?: Error | null) => void,
      ): boolean => {
        const text =
          typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
        writtenMessages.push(text);
        return true;
      },
    );
  process.stdout.write = mockWrite as typeof process.stdout.write;

  return {
    sandbox,
    inputStream,
    reader,
    writtenMessages,
    restore() {
      process.stdout.write = originalWrite;
      reader.close();
      inputStream.destroy();
    },
  };
}

describe("RpcSandbox", () => {
  beforeEach(() => {
    resetRequestCounter();
  });

  it("should have the correct ID", () => {
    const { sandbox, restore } = createTestSandbox("my-session");
    expect(sandbox.id).toBe("my-session");
    restore();
  });

  it("should send exec_request on execute() and resolve on exec_response", async () => {
    const { sandbox, inputStream, writtenMessages, restore } =
      createTestSandbox();

    sandbox.startListening();

    // Call execute - this will send a request and wait for a response
    const executePromise = sandbox.execute("echo hello");

    // Wait a tick for the request to be sent
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Check that the request was sent to stdout
    expect(writtenMessages.length).toBe(1);
    const request = JSON.parse(writtenMessages[0].trim());
    expect(request.type).toBe("exec_request");
    expect(request.id).toBe("req-1");
    expect(request.command).toBe("echo hello");

    // Simulate Python sending back a response
    inputStream.push(
      JSON.stringify({
        type: "exec_response",
        id: "req-1",
        output: "hello",
        exitCode: 0,
      }) + "\n",
    );

    // Wait for the response to be processed
    const result = await executePromise;
    expect(result.output).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(false);

    restore();
  });

  it("should handle multiple concurrent execute() calls", async () => {
    const { sandbox, inputStream, writtenMessages, restore } =
      createTestSandbox();

    sandbox.startListening();

    // Fire two requests concurrently
    const promise1 = sandbox.execute("echo one");
    const promise2 = sandbox.execute("echo two");

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Both requests should have been sent
    expect(writtenMessages.length).toBe(2);

    // Send responses (out of order to test matching)
    inputStream.push(
      JSON.stringify({
        type: "exec_response",
        id: "req-2",
        output: "two",
        exitCode: 0,
      }) + "\n",
    );
    inputStream.push(
      JSON.stringify({
        type: "exec_response",
        id: "req-1",
        output: "one",
        exitCode: 0,
      }) + "\n",
    );

    const [result1, result2] = await Promise.all([promise1, promise2]);
    expect(result1.output).toBe("one");
    expect(result2.output).toBe("two");

    restore();
  });

  it("should reject pending requests on dispose()", async () => {
    const { sandbox, restore } = createTestSandbox();

    sandbox.startListening();

    // Fire a request that will never get a response
    const promise = sandbox.execute("echo never");

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Dispose should reject the pending request
    sandbox.dispose();

    await expect(promise).rejects.toThrow("RpcSandbox disposed");

    restore();
  });

  it("should route non-exec messages to the message handler", async () => {
    const { sandbox, inputStream, restore } = createTestSandbox();

    const receivedMessages: unknown[] = [];
    sandbox.setMessageHandler((msg) => {
      receivedMessages.push(msg);
    });

    sandbox.startListening();

    // Send an init message (not an exec_response)
    inputStream.push(
      JSON.stringify({
        type: "init",
        instruction: "do something",
        sessionId: "s-1",
        model: "test-model",
        systemPrompt: "test prompt",
      }) + "\n",
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(receivedMessages.length).toBe(1);
    expect((receivedMessages[0] as { type: string }).type).toBe("init");

    restore();
  });

  describe("uploadFiles", () => {
    it("should upload files via execute using base64 encoding", async () => {
      const { sandbox, inputStream, writtenMessages, restore } =
        createTestSandbox();

      sandbox.startListening();

      const encoder = new TextEncoder();
      const uploadPromise = sandbox.uploadFiles([
        ["/app/test.txt", encoder.encode("hello world")],
      ]);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should have sent an exec_request
      expect(writtenMessages.length).toBe(1);
      const request = JSON.parse(writtenMessages[0].trim());
      expect(request.type).toBe("exec_request");
      expect(request.command).toContain("base64");

      // Respond with success
      inputStream.push(
        JSON.stringify({
          type: "exec_response",
          id: request.id,
          output: "",
          exitCode: 0,
        }) + "\n",
      );

      const results = await uploadPromise;
      expect(results.length).toBe(1);
      expect(results[0].path).toBe("/app/test.txt");
      expect(results[0].error).toBeNull();

      restore();
    });
  });

  describe("downloadFiles", () => {
    it("should download files via execute using base64 encoding", async () => {
      const { sandbox, inputStream, writtenMessages, restore } =
        createTestSandbox();

      sandbox.startListening();

      const downloadPromise = sandbox.downloadFiles(["/app/test.txt"]);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should have sent an exec_request
      expect(writtenMessages.length).toBe(1);
      const request = JSON.parse(writtenMessages[0].trim());
      expect(request.type).toBe("exec_request");

      // Respond with base64-encoded content
      const b64Content = Buffer.from("hello world").toString("base64");
      inputStream.push(
        JSON.stringify({
          type: "exec_response",
          id: request.id,
          output: b64Content,
          exitCode: 0,
        }) + "\n",
      );

      const results = await downloadPromise;
      expect(results.length).toBe(1);
      expect(results[0].path).toBe("/app/test.txt");
      expect(results[0].error).toBeNull();
      expect(new TextDecoder().decode(results[0].content!)).toBe(
        "hello world",
      );

      restore();
    });

    it("should handle file not found", async () => {
      const { sandbox, inputStream, writtenMessages, restore } =
        createTestSandbox();

      sandbox.startListening();

      const downloadPromise = sandbox.downloadFiles(["/app/missing.txt"]);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const request = JSON.parse(writtenMessages[0].trim());

      // Respond with not found
      inputStream.push(
        JSON.stringify({
          type: "exec_response",
          id: request.id,
          output: "__NOT_FOUND__",
          exitCode: 1,
        }) + "\n",
      );

      const results = await downloadPromise;
      expect(results.length).toBe(1);
      expect(results[0].error).toBe("file_not_found");
      expect(results[0].content).toBeNull();

      restore();
    });
  });
});
