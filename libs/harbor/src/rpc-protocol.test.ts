import { describe, it, expect, beforeEach } from "vitest";

import {
  parseIncomingMessage,
  nextRequestId,
  resetRequestCounter,
  type InitMessage,
  type ExecResponse,
} from "./rpc-protocol.js";

describe("rpc-protocol", () => {
  describe("parseIncomingMessage", () => {
    it("should parse a valid init message", () => {
      const json = JSON.stringify({
        type: "init",
        instruction: "Write hello world",
        sessionId: "session-123",
        model: "anthropic:claude-sonnet-4-5-20250929",
        systemPrompt: "You are an agent.",
      });

      const msg = parseIncomingMessage(json);
      expect(msg).not.toBeNull();
      expect(msg!.type).toBe("init");

      const init = msg as InitMessage;
      expect(init.instruction).toBe("Write hello world");
      expect(init.sessionId).toBe("session-123");
      expect(init.model).toBe("anthropic:claude-sonnet-4-5-20250929");
      expect(init.systemPrompt).toBe("You are an agent.");
    });

    it("should parse a valid exec_response message", () => {
      const json = JSON.stringify({
        type: "exec_response",
        id: "req-1",
        output: "file1.txt\nfile2.txt",
        exitCode: 0,
      });

      const msg = parseIncomingMessage(json);
      expect(msg).not.toBeNull();
      expect(msg!.type).toBe("exec_response");

      const resp = msg as ExecResponse;
      expect(resp.id).toBe("req-1");
      expect(resp.output).toBe("file1.txt\nfile2.txt");
      expect(resp.exitCode).toBe(0);
    });

    it("should return null for empty strings", () => {
      expect(parseIncomingMessage("")).toBeNull();
      expect(parseIncomingMessage("   ")).toBeNull();
    });

    it("should return null for invalid JSON", () => {
      expect(parseIncomingMessage("not json")).toBeNull();
      expect(parseIncomingMessage("{broken")).toBeNull();
    });

    it("should return null for JSON without type field", () => {
      expect(parseIncomingMessage('{"id": "req-1"}')).toBeNull();
    });

    it("should handle exec_response with non-zero exit code", () => {
      const json = JSON.stringify({
        type: "exec_response",
        id: "req-5",
        output: "command not found",
        exitCode: 127,
      });

      const msg = parseIncomingMessage(json) as ExecResponse;
      expect(msg.exitCode).toBe(127);
      expect(msg.output).toBe("command not found");
    });
  });

  describe("nextRequestId", () => {
    beforeEach(() => {
      resetRequestCounter();
    });

    it("should generate incrementing request IDs", () => {
      expect(nextRequestId()).toBe("req-1");
      expect(nextRequestId()).toBe("req-2");
      expect(nextRequestId()).toBe("req-3");
    });

    it("should reset properly", () => {
      nextRequestId();
      nextRequestId();
      resetRequestCounter();
      expect(nextRequestId()).toBe("req-1");
    });
  });
});
