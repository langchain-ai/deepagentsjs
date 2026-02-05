/**
 * Unit tests for the Logger utility
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Logger, createLogger, nullLogger } from "./logger.js";

describe("Logger", () => {
  let tempDir: string;
  let logFilePath: string;

  beforeEach(() => {
    // Create temp directory for log files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepagents-test-"));
    logFilePath = path.join(tempDir, "test.log");
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Cleanup temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("constructor", () => {
    it("should create logger with default options", () => {
      const logger = new Logger();
      expect(logger.isEnabled()).toBe(false);
      expect(logger.hasFileLogging()).toBe(false);
    });

    it("should enable debug logging when debug=true", () => {
      const logger = new Logger({ debug: true });
      expect(logger.isEnabled()).toBe(true);
    });

    it("should enable file logging when logFile is provided", () => {
      const logger = new Logger({ logFile: logFilePath });
      expect(logger.isEnabled()).toBe(true);
      expect(logger.hasFileLogging()).toBe(true);
      expect(logger.getLogFilePath()).toBe(logFilePath);
    });

    it("should create log file directory if it doesn't exist", () => {
      const nestedPath = path.join(tempDir, "nested", "dir", "test.log");
      const logger = new Logger({ logFile: nestedPath });
      expect(logger.hasFileLogging()).toBe(true);
      expect(fs.existsSync(path.dirname(nestedPath))).toBe(true);
    });
  });

  describe("logging methods", () => {
    it("should log to stderr when debug=true", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logger = new Logger({ debug: true });

      logger.log("test message");

      expect(consoleSpy).toHaveBeenCalled();
      expect(consoleSpy.mock.calls[0][0]).toContain("test message");
      consoleSpy.mockRestore();
    });

    it("should not log to stderr when debug=false", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logger = new Logger({ debug: false });

      logger.log("test message");

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should log errors to stderr even when debug=false", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logger = new Logger({ debug: false });

      logger.error("error message");

      // Errors should still be logged
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should write to file when logFile is provided", async () => {
      const logger = new Logger({ logFile: logFilePath });

      logger.log("file message");
      await logger.close();

      const content = fs.readFileSync(logFilePath, "utf8");
      expect(content).toContain("file message");
    });

    it("should include timestamps in file logs", async () => {
      const logger = new Logger({ logFile: logFilePath });

      logger.log("timestamp test");
      await logger.close();

      const content = fs.readFileSync(logFilePath, "utf8");
      // ISO timestamp format
      expect(content).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("should use custom prefix", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logger = new Logger({
        debug: true,
        prefix: "[custom-prefix]",
      });

      logger.log("test");

      expect(consoleSpy.mock.calls[0][0]).toContain("[custom-prefix]");
      consoleSpy.mockRestore();
    });
  });

  describe("log levels", () => {
    it("should support info level", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logger = new Logger({ debug: true });

      logger.info("info message");

      expect(consoleSpy.mock.calls[0][0]).toContain("[INFO]");
      consoleSpy.mockRestore();
    });

    it("should support warn level", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logger = new Logger({ debug: true });

      logger.warn("warning message");

      expect(consoleSpy.mock.calls[0][0]).toContain("[WARN]");
      consoleSpy.mockRestore();
    });

    it("should support error level", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logger = new Logger({ debug: true });

      logger.error("error message");

      expect(consoleSpy.mock.calls[0][0]).toContain("[ERROR]");
      consoleSpy.mockRestore();
    });

    it("should format Error objects with stack trace", async () => {
      const logger = new Logger({ logFile: logFilePath });
      const error = new Error("test error");

      logger.error(error);
      await logger.close();

      const content = fs.readFileSync(logFilePath, "utf8");
      expect(content).toContain("test error");
      expect(content).toContain("Error:");
    });

    it("should stringify objects", async () => {
      const logger = new Logger({ logFile: logFilePath });

      logger.log({ key: "value", nested: { a: 1 } });
      await logger.close();

      const content = fs.readFileSync(logFilePath, "utf8");
      expect(content).toContain('"key"');
      expect(content).toContain('"value"');
    });
  });

  describe("close", () => {
    it("should write shutdown message on close", async () => {
      const logger = new Logger({ logFile: logFilePath });

      logger.log("before close");
      await logger.close();

      const content = fs.readFileSync(logFilePath, "utf8");
      expect(content).toContain("Shutting down");
    });

    it("should be safe to call close multiple times", async () => {
      const logger = new Logger({ logFile: logFilePath });

      await logger.close();
      await expect(logger.close()).resolves.not.toThrow();
    });
  });

  describe("flush", () => {
    it("should flush pending writes", async () => {
      const logger = new Logger({ logFile: logFilePath });

      logger.log("flush test");
      await logger.flush();
      await logger.close();

      const content = fs.readFileSync(logFilePath, "utf8");
      expect(content).toContain("flush test");
    });
  });
});

describe("createLogger", () => {
  it("should create a logger instance", () => {
    const logger = createLogger({ debug: true });
    expect(logger).toBeInstanceOf(Logger);
  });

  it("should pass options to Logger", () => {
    const logger = createLogger({ debug: true, prefix: "[test]" });
    expect(logger.isEnabled()).toBe(true);
  });
});

describe("nullLogger", () => {
  it("should have all logger methods", () => {
    expect(typeof nullLogger.log).toBe("function");
    expect(typeof nullLogger.info).toBe("function");
    expect(typeof nullLogger.warn).toBe("function");
    expect(typeof nullLogger.error).toBe("function");
    expect(typeof nullLogger.close).toBe("function");
  });

  it("should return false for isEnabled", () => {
    expect(nullLogger.isEnabled()).toBe(false);
  });

  it("should return false for hasFileLogging", () => {
    expect(nullLogger.hasFileLogging()).toBe(false);
  });

  it("should return null for getLogFilePath", () => {
    expect(nullLogger.getLogFilePath()).toBeNull();
  });

  it("should not throw when called", () => {
    expect(() => nullLogger.log("test")).not.toThrow();
    expect(() => nullLogger.error("test")).not.toThrow();
  });
});
