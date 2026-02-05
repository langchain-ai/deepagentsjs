/* eslint-disable no-console */
/**
 * Logger utility for DeepAgents ACP Server
 *
 * Supports logging to stderr (for debug mode) and/or a file (for production debugging).
 * All output goes to stderr or file to keep stdout clean for ACP protocol communication.
 */

import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
  /**
   * Enable debug logging to stderr
   */
  debug?: boolean;

  /**
   * Path to log file for persistent logging
   * If provided, logs will be written to this file regardless of debug flag
   */
  logFile?: string;

  /**
   * Minimum log level to output (default: "debug" if debug=true, "info" otherwise)
   */
  minLevel?: LogLevel;

  /**
   * Prefix for log messages
   */
  prefix?: string;

  /**
   * Include timestamps in log messages (default: true for file, false for stderr)
   */
  timestamps?: boolean;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Logger class for DeepAgents ACP Server
 */
export class Logger {
  private debug: boolean;
  private logFile: string | null;
  private fileStream: fs.WriteStream | null = null;
  private minLevel: number;
  private prefix: string;
  private timestampsForStderr: boolean;
  private timestampsForFile: boolean;

  constructor(options: LoggerOptions = {}) {
    this.debug = options.debug ?? false;
    this.logFile = options.logFile ?? null;
    this.prefix = options.prefix ?? "[deepagents-server]";
    this.timestampsForStderr = options.timestamps ?? false;
    this.timestampsForFile = true; // Always include timestamps in file logs

    // Determine minimum log level
    if (options.minLevel) {
      this.minLevel = LOG_LEVELS[options.minLevel];
    } else {
      this.minLevel = this.debug ? LOG_LEVELS.debug : LOG_LEVELS.info;
    }

    // Initialize file stream if logFile is provided
    if (this.logFile) {
      this.initFileStream(this.logFile);
    }
  }

  /**
   * Initialize the file write stream
   */
  private initFileStream(logFilePath: string): void {
    try {
      // Resolve the path
      const resolvedPath = path.resolve(logFilePath);

      // Ensure the directory exists
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Open file stream in append mode
      this.fileStream = fs.createWriteStream(resolvedPath, {
        flags: "a",
        encoding: "utf8",
      });

      // Write startup marker
      const startupMessage = `\n${"=".repeat(60)}\n${this.prefix} Started at ${new Date().toISOString()}\n${"=".repeat(60)}\n`;
      this.fileStream.write(startupMessage);

      // Handle stream errors
      this.fileStream.on("error", (err) => {
        console.error(`${this.prefix} Log file error:`, err);
        this.fileStream = null;
      });
    } catch (err) {
      console.error(`${this.prefix} Failed to initialize log file:`, err);
      this.fileStream = null;
    }
  }

  /**
   * Format a log message
   */
  private formatMessage(
    level: LogLevel,
    args: unknown[],
    includeTimestamp: boolean,
  ): string {
    const timestamp = includeTimestamp ? `[${new Date().toISOString()}] ` : "";
    const levelTag = `[${level.toUpperCase()}]`;
    const message = args
      .map((arg) => {
        // eslint-disable-next-line no-instanceof/no-instanceof
        if (arg instanceof Error) {
          return `${arg.message}\n${arg.stack}`;
        }
        if (typeof arg === "object") {
          try {
            return JSON.stringify(arg, null, 2);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      })
      .join(" ");

    return `${timestamp}${this.prefix} ${levelTag} ${message}`;
  }

  /**
   * Write a log message
   */
  private write(level: LogLevel, args: unknown[]): void {
    const levelNum = LOG_LEVELS[level];

    // Check if we should log at this level
    if (levelNum < this.minLevel && !this.logFile) {
      return;
    }

    // Write to stderr if debug mode or level >= minLevel
    if (this.debug || levelNum >= LOG_LEVELS.warn) {
      const stderrMessage = this.formatMessage(
        level,
        args,
        this.timestampsForStderr,
      );
      console.error(stderrMessage);
    }

    // Write to file if configured
    if (this.fileStream) {
      const fileMessage = this.formatMessage(
        level,
        args,
        this.timestampsForFile,
      );
      this.fileStream.write(fileMessage + "\n");
    }
  }

  /**
   * Log a debug message
   */
  log(...args: unknown[]): void {
    this.write("debug", args);
  }

  /**
   * Log a debug message (alias for log)
   */
  debug_log(...args: unknown[]): void {
    this.write("debug", args);
  }

  /**
   * Log an info message
   */
  info(...args: unknown[]): void {
    this.write("info", args);
  }

  /**
   * Log a warning message
   */
  warn(...args: unknown[]): void {
    this.write("warn", args);
  }

  /**
   * Log an error message
   */
  error(...args: unknown[]): void {
    this.write("error", args);
  }

  /**
   * Log with a specific level
   */
  logLevel(level: LogLevel, ...args: unknown[]): void {
    this.write(level, args);
  }

  /**
   * Check if logging is enabled (either debug or file)
   */
  isEnabled(): boolean {
    return this.debug || this.fileStream !== null;
  }

  /**
   * Check if file logging is enabled
   */
  hasFileLogging(): boolean {
    return this.fileStream !== null;
  }

  /**
   * Get the log file path
   */
  getLogFilePath(): string | null {
    return this.logFile;
  }

  /**
   * Close the logger and flush any pending writes
   */
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.fileStream) {
        const shutdownMessage = `${this.prefix} Shutting down at ${new Date().toISOString()}\n${"=".repeat(60)}\n`;
        this.fileStream.write(shutdownMessage, () => {
          this.fileStream?.end(() => {
            this.fileStream = null;
            resolve();
          });
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Flush pending writes to file
   */
  flush(): Promise<void> {
    return new Promise((resolve) => {
      if (this.fileStream) {
        // Use drain event if write buffer is full
        if (!this.fileStream.write("")) {
          this.fileStream.once("drain", resolve);
        } else {
          resolve();
        }
      } else {
        resolve();
      }
    });
  }
}

/**
 * Create a logger instance
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  return new Logger(options);
}

/**
 * Default no-op logger for when logging is disabled
 */
export const nullLogger: Logger = {
  log: () => {},
  debug_log: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  logLevel: () => {},
  isEnabled: () => false,
  hasFileLogging: () => false,
  getLogFilePath: () => null,
  close: () => Promise.resolve(),
  flush: () => Promise.resolve(),
} as unknown as Logger;
