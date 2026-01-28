import { describe, it, expect, afterEach } from "vitest";
import {
  getPlatformKey,
  getPlatformInfo,
  getSupportedPlatforms,
  getUnsupportedPlatformMessage,
} from "./index.js";

describe("index", () => {
  describe("getPlatformKey", () => {
    it("returns current platform key", () => {
      const key = getPlatformKey();
      expect(key).toBe(`${process.platform}-${process.arch}`);
    });

    it("returns string in correct format", () => {
      const key = getPlatformKey();
      expect(key).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    });
  });

  describe("getPlatformInfo", () => {
    // Save original values
    const originalPlatform = process.platform;
    const originalArch = process.arch;

    afterEach(() => {
      // Restore original values
      Object.defineProperty(process, "platform", { value: originalPlatform });
      Object.defineProperty(process, "arch", { value: originalArch });
    });

    it("returns info for darwin-arm64", () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      Object.defineProperty(process, "arch", { value: "arm64" });

      const info = getPlatformInfo();
      expect(info).not.toBeNull();
      expect(info?.packageName).toBe("@deepagents-cli/darwin-arm64");
      expect(info?.binaryName).toBe("deepagents");
      expect(info?.os).toBe("darwin");
      expect(info?.cpu).toBe("arm64");
    });

    it("returns info for darwin-x64", () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      Object.defineProperty(process, "arch", { value: "x64" });

      const info = getPlatformInfo();
      expect(info).not.toBeNull();
      expect(info?.packageName).toBe("@deepagents-cli/darwin-x64");
      expect(info?.binaryName).toBe("deepagents");
    });

    it("returns info for linux-x64", () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      Object.defineProperty(process, "arch", { value: "x64" });

      const info = getPlatformInfo();
      expect(info).not.toBeNull();
      expect(info?.packageName).toBe("@deepagents-cli/linux-x64");
      expect(info?.binaryName).toBe("deepagents");
    });

    it("returns info for linux-arm64", () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      Object.defineProperty(process, "arch", { value: "arm64" });

      const info = getPlatformInfo();
      expect(info).not.toBeNull();
      expect(info?.packageName).toBe("@deepagents-cli/linux-arm64");
    });

    it("returns info for win32-x64 with .exe extension", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      Object.defineProperty(process, "arch", { value: "x64" });

      const info = getPlatformInfo();
      expect(info).not.toBeNull();
      expect(info?.packageName).toBe("@deepagents-cli/win32-x64");
      expect(info?.binaryName).toBe("deepagents.exe");
      expect(info?.os).toBe("win32");
    });

    it("returns null for unsupported platform (freebsd)", () => {
      Object.defineProperty(process, "platform", { value: "freebsd" });
      Object.defineProperty(process, "arch", { value: "x64" });

      const info = getPlatformInfo();
      expect(info).toBeNull();
    });

    it("returns null for unsupported architecture (arm)", () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      Object.defineProperty(process, "arch", { value: "arm" });

      const info = getPlatformInfo();
      expect(info).toBeNull();
    });

    it("returns null for win32-arm64 (not supported)", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      Object.defineProperty(process, "arch", { value: "arm64" });

      const info = getPlatformInfo();
      expect(info).toBeNull();
    });
  });

  describe("getSupportedPlatforms", () => {
    it("returns array of supported platforms", () => {
      const platforms = getSupportedPlatforms();
      expect(Array.isArray(platforms)).toBe(true);
      expect(platforms.length).toBe(5);
    });

    it("includes all expected platforms", () => {
      const platforms = getSupportedPlatforms();
      expect(platforms).toContain("linux-x64");
      expect(platforms).toContain("linux-arm64");
      expect(platforms).toContain("darwin-x64");
      expect(platforms).toContain("darwin-arm64");
      expect(platforms).toContain("win32-x64");
    });
  });

  describe("getUnsupportedPlatformMessage", () => {
    const originalPlatform = process.platform;
    const originalArch = process.arch;

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      Object.defineProperty(process, "arch", { value: originalArch });
    });

    it("includes platform key for unsupported platform", () => {
      Object.defineProperty(process, "platform", { value: "freebsd" });
      Object.defineProperty(process, "arch", { value: "x64" });

      const message = getUnsupportedPlatformMessage();
      expect(message).toContain("freebsd-x64");
      expect(message).toContain("not supported");
    });

    it("lists supported platforms when unsupported", () => {
      Object.defineProperty(process, "platform", { value: "freebsd" });
      Object.defineProperty(process, "arch", { value: "x64" });

      const message = getUnsupportedPlatformMessage();
      expect(message).toContain("linux-x64");
      expect(message).toContain("darwin-arm64");
    });

    it("suggests reinstall for supported but missing binary", () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      Object.defineProperty(process, "arch", { value: "arm64" });

      const message = getUnsupportedPlatformMessage();
      expect(message).toContain("reinstall");
      expect(message).toContain("npm install -g deepagents-cli");
    });
  });
});
