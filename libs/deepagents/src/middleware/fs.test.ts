import { describe, it, expect } from "vitest";
import {
  fileDataReducer,
  type FilesRecord,
  type FilesRecordUpdate,
} from "./fs.js";
import type { FileData } from "../backends/protocol.js";

describe("fileDataReducer", () => {
  // Helper to create a FileData object
  function createFileData(
    content: string[],
    createdAt = "2024-01-01T00:00:00Z",
    modifiedAt = "2024-01-01T00:00:00Z",
  ): FileData {
    return {
      content,
      created_at: createdAt,
      modified_at: modifiedAt,
    };
  }

  describe("edge cases", () => {
    it("should return empty object when both current and update are undefined", () => {
      const result = fileDataReducer(undefined, undefined);
      expect(result).toEqual({});
    });

    it("should return current when update is undefined", () => {
      const current: FilesRecord = {
        "/file.txt": createFileData(["hello"]),
      };
      const result = fileDataReducer(current, undefined);
      expect(result).toEqual(current);
    });

    it("should return empty object when current is undefined and update is empty", () => {
      const result = fileDataReducer(undefined, {});
      expect(result).toEqual({});
    });

    it("should filter out null values when current is undefined", () => {
      const update: FilesRecordUpdate = {
        "/file.txt": createFileData(["hello"]),
        "/deleted.txt": null,
      };
      const result = fileDataReducer(undefined, update);
      expect(result).toEqual({
        "/file.txt": createFileData(["hello"]),
      });
    });
  });

  describe("adding files", () => {
    it("should add new files to empty state", () => {
      const update: FilesRecordUpdate = {
        "/new-file.txt": createFileData(["new content"]),
      };
      const result = fileDataReducer({}, update);
      expect(result).toEqual({
        "/new-file.txt": createFileData(["new content"]),
      });
    });

    it("should add new files to existing state", () => {
      const current: FilesRecord = {
        "/existing.txt": createFileData(["existing"]),
      };
      const update: FilesRecordUpdate = {
        "/new-file.txt": createFileData(["new content"]),
      };
      const result = fileDataReducer(current, update);
      expect(result).toEqual({
        "/existing.txt": createFileData(["existing"]),
        "/new-file.txt": createFileData(["new content"]),
      });
    });

    it("should add multiple files at once", () => {
      const current: FilesRecord = {
        "/existing.txt": createFileData(["existing"]),
      };
      const update: FilesRecordUpdate = {
        "/file1.txt": createFileData(["content 1"]),
        "/file2.txt": createFileData(["content 2"]),
        "/file3.txt": createFileData(["content 3"]),
      };
      const result = fileDataReducer(current, update);
      expect(Object.keys(result)).toHaveLength(4);
      expect(result["/file1.txt"]).toEqual(createFileData(["content 1"]));
      expect(result["/file2.txt"]).toEqual(createFileData(["content 2"]));
      expect(result["/file3.txt"]).toEqual(createFileData(["content 3"]));
    });
  });

  describe("updating files", () => {
    it("should update existing file content", () => {
      const current: FilesRecord = {
        "/file.txt": createFileData(["old content"], "2024-01-01T00:00:00Z"),
      };
      const update: FilesRecordUpdate = {
        "/file.txt": createFileData(["new content"], "2024-01-02T00:00:00Z"),
      };
      const result = fileDataReducer(current, update);
      expect(result["/file.txt"].content).toEqual(["new content"]);
      expect(result["/file.txt"].created_at).toBe("2024-01-02T00:00:00Z");
    });

    it("should update only the modified files", () => {
      const current: FilesRecord = {
        "/file1.txt": createFileData(["content 1"]),
        "/file2.txt": createFileData(["content 2"]),
        "/file3.txt": createFileData(["content 3"]),
      };
      const update: FilesRecordUpdate = {
        "/file2.txt": createFileData(["updated content 2"]),
      };
      const result = fileDataReducer(current, update);
      expect(result["/file1.txt"].content).toEqual(["content 1"]);
      expect(result["/file2.txt"].content).toEqual(["updated content 2"]);
      expect(result["/file3.txt"].content).toEqual(["content 3"]);
    });
  });

  describe("deleting files", () => {
    it("should delete a file when value is null", () => {
      const current: FilesRecord = {
        "/file.txt": createFileData(["content"]),
        "/keep.txt": createFileData(["keep this"]),
      };
      const update: FilesRecordUpdate = {
        "/file.txt": null,
      };
      const result = fileDataReducer(current, update);
      expect(result).toEqual({
        "/keep.txt": createFileData(["keep this"]),
      });
      expect("/file.txt" in result).toBe(false);
    });

    it("should delete multiple files at once", () => {
      const current: FilesRecord = {
        "/file1.txt": createFileData(["content 1"]),
        "/file2.txt": createFileData(["content 2"]),
        "/file3.txt": createFileData(["content 3"]),
        "/keep.txt": createFileData(["keep"]),
      };
      const update: FilesRecordUpdate = {
        "/file1.txt": null,
        "/file3.txt": null,
      };
      const result = fileDataReducer(current, update);
      expect(Object.keys(result)).toHaveLength(2);
      expect(result["/file2.txt"]).toBeDefined();
      expect(result["/keep.txt"]).toBeDefined();
    });

    it("should handle deletion of non-existent file gracefully", () => {
      const current: FilesRecord = {
        "/file.txt": createFileData(["content"]),
      };
      const update: FilesRecordUpdate = {
        "/non-existent.txt": null,
      };
      const result = fileDataReducer(current, update);
      expect(result).toEqual({
        "/file.txt": createFileData(["content"]),
      });
    });
  });

  describe("mixed operations", () => {
    it("should handle add, update, and delete in single update", () => {
      const current: FilesRecord = {
        "/existing.txt": createFileData(["existing"]),
        "/to-update.txt": createFileData(["old"]),
        "/to-delete.txt": createFileData(["will be deleted"]),
      };
      const update: FilesRecordUpdate = {
        "/new-file.txt": createFileData(["new"]),
        "/to-update.txt": createFileData(["updated"]),
        "/to-delete.txt": null,
      };
      const result = fileDataReducer(current, update);
      expect(Object.keys(result).sort()).toEqual([
        "/existing.txt",
        "/new-file.txt",
        "/to-update.txt",
      ]);
      expect(result["/existing.txt"].content).toEqual(["existing"]);
      expect(result["/new-file.txt"].content).toEqual(["new"]);
      expect(result["/to-update.txt"].content).toEqual(["updated"]);
    });
  });

  describe("parallel subagent simulation", () => {
    it("should handle concurrent file updates from multiple parallel subagents", () => {
      // Simulate: main agent has some files, two subagents run in parallel
      const mainAgentFiles: FilesRecord = {
        "/shared.txt": createFileData(["main agent version"]),
        "/main-only.txt": createFileData(["only in main"]),
      };

      // First subagent creates and modifies files
      const subagent1Update: FilesRecordUpdate = {
        "/shared.txt": createFileData(["subagent 1 version"]),
        "/subagent1.txt": createFileData(["from subagent 1"]),
      };

      // Second subagent creates and modifies files
      const subagent2Update: FilesRecordUpdate = {
        "/shared.txt": createFileData(["subagent 2 version"]),
        "/subagent2.txt": createFileData(["from subagent 2"]),
      };

      // Apply updates sequentially (as the reducer would be called)
      const afterSubagent1 = fileDataReducer(mainAgentFiles, subagent1Update);
      const afterSubagent2 = fileDataReducer(afterSubagent1, subagent2Update);

      expect(Object.keys(afterSubagent2).sort()).toEqual([
        "/main-only.txt",
        "/shared.txt",
        "/subagent1.txt",
        "/subagent2.txt",
      ]);

      // Last update wins for shared file
      expect(afterSubagent2["/shared.txt"].content).toEqual([
        "subagent 2 version",
      ]);
    });

    it("should handle one subagent adding and another deleting the same file", () => {
      const current: FilesRecord = {
        "/existing.txt": createFileData(["existing"]),
      };

      // First subagent adds a file
      const subagent1Update: FilesRecordUpdate = {
        "/new-file.txt": createFileData(["created by subagent 1"]),
      };

      // Second subagent deletes that same file (e.g., cleanup operation)
      const subagent2Update: FilesRecordUpdate = {
        "/new-file.txt": null,
      };

      const afterSubagent1 = fileDataReducer(current, subagent1Update);
      expect(afterSubagent1["/new-file.txt"]).toBeDefined();

      const afterSubagent2 = fileDataReducer(afterSubagent1, subagent2Update);
      expect("/new-file.txt" in afterSubagent2).toBe(false);
    });

    it("should preserve file metadata through merges", () => {
      const current: FilesRecord = {
        "/file.txt": {
          content: ["line 1", "line 2", "line 3"],
          created_at: "2024-01-01T00:00:00Z",
          modified_at: "2024-01-01T12:00:00Z",
        },
      };

      const update: FilesRecordUpdate = {
        "/file.txt": {
          content: ["updated line 1", "updated line 2"],
          created_at: "2024-01-02T00:00:00Z",
          modified_at: "2024-01-02T12:00:00Z",
        },
      };

      const result = fileDataReducer(current, update);

      expect(result["/file.txt"]).toEqual(update["/file.txt"]);
      expect(result["/file.txt"].content).toEqual([
        "updated line 1",
        "updated line 2",
      ]);
      expect(result["/file.txt"].created_at).toBe("2024-01-02T00:00:00Z");
      expect(result["/file.txt"].modified_at).toBe("2024-01-02T12:00:00Z");
    });
  });

  describe("immutability", () => {
    it("should not mutate the current state", () => {
      const current: FilesRecord = {
        "/file.txt": createFileData(["original"]),
      };
      const originalCurrent = JSON.parse(JSON.stringify(current));

      const update: FilesRecordUpdate = {
        "/file.txt": createFileData(["updated"]),
        "/new.txt": createFileData(["new"]),
      };

      fileDataReducer(current, update);

      expect(current).toEqual(originalCurrent);
    });

    it("should return a new object reference", () => {
      const current: FilesRecord = {
        "/file.txt": createFileData(["content"]),
      };
      const update: FilesRecordUpdate = {
        "/new.txt": createFileData(["new"]),
      };

      const result = fileDataReducer(current, update);

      expect(result).not.toBe(current);
    });
  });
});
