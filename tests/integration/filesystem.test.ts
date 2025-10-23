import { describe, it, expect } from "vitest";
import { createAgent } from "langchain";
import { HumanMessage } from "@langchain/core/messages";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent } from "../../src/index.js";
import { createFilesystemMiddleware } from "../../src/middleware/fs.js";
import {
  WRITE_FILE_TOOL_DESCRIPTION,
  WRITE_FILE_TOOL_DESCRIPTION_LONGTERM_SUPPLEMENT,
} from "../../src/middleware/fs.js";
import { v4 as uuidv4 } from "uuid";
import {
  SAMPLE_MODEL,
  getPremierLeagueStandings,
  getLaLigaStandings,
  getNbaStandings,
  getNflStandings,
} from "../utils.js";

describe("Filesystem Middleware Integration Tests", () => {
  it("should fail when using longterm memory without store", async () => {
    expect(() => {
      createDeepAgent({
        tools: [],
        useLongtermMemory: true,
        // No store provided
      });
    }).toThrow();
  });

  it(
    "should override filesystem system prompt",
    { timeout: 60000 },
    async () => {
      const filesystemMiddleware = createFilesystemMiddleware({
        longTermMemory: false,
        systemPrompt:
          "In every single response, you must say the word 'pokemon'! You love it!",
      });
      const agent = createAgent({
        model: SAMPLE_MODEL,
        middleware: [filesystemMiddleware],
      });

      const response = await agent.invoke({
        messages: [new HumanMessage("What do you like?")],
      });

      const lastMessage = response.messages[response.messages.length - 1];
      expect(lastMessage.content.toString().toLowerCase()).toContain("pokemon");
    }
  );

  it(
    "should override filesystem system prompt with longterm memory",
    { timeout: 60000 },
    async () => {
      const store = new InMemoryStore();
      const filesystemMiddleware = createFilesystemMiddleware({
        longTermMemory: true,
        systemPrompt:
          "In every single response, you must say the word 'pizza'! You love it!",
      });
      const agent = createAgent({
        model: SAMPLE_MODEL,
        middleware: [filesystemMiddleware],
        store,
      });

      const response = await agent.invoke({
        messages: [new HumanMessage("What do you like?")],
      });

      const lastMessage = response.messages[response.messages.length - 1];
      expect(lastMessage.content.toString().toLowerCase()).toContain("pizza");
    }
  );

  it("should override filesystem tool descriptions", () => {
    const agent = createAgent({
      model: SAMPLE_MODEL,
      middleware: [
        createFilesystemMiddleware({
          longTermMemory: false,
          customToolDescriptions: {
            ls: "Charmander",
            read_file: "Bulbasaur",
            edit_file: "Squirtle",
          },
        }),
      ],
      tools: [], // Required to bind tools from middleware
    });

    const toolsArray = (agent as any).graph?.nodes?.tools?.bound?.tools || [];
    const tools: Record<string, any> = {};
    for (const tool of toolsArray) {
      tools[tool.name] = tool;
    }

    expect(tools.ls).toBeDefined();
    expect(tools.ls.description).toBe("Charmander");
    expect(tools.read_file).toBeDefined();
    expect(tools.read_file.description).toBe("Bulbasaur");
    expect(tools.write_file).toBeDefined();
    expect(tools.write_file.description).toBe(WRITE_FILE_TOOL_DESCRIPTION);
    expect(tools.edit_file).toBeDefined();
    expect(tools.edit_file.description).toBe("Squirtle");
  });

  it("should override filesystem tool descriptions with longterm memory", () => {
    const store = new InMemoryStore();
    const agent = createAgent({
      model: SAMPLE_MODEL,
      middleware: [
        createFilesystemMiddleware({
          longTermMemory: true,
          customToolDescriptions: {
            ls: "Charmander",
            read_file: "Bulbasaur",
            edit_file: "Squirtle",
          },
          store, // Pass store to middleware instead of createAgent
        }),
      ],
      tools: [], // Required to bind tools from middleware
    });

    const toolsArray = (agent as any).graph?.nodes?.tools?.bound?.tools || [];
    const tools: Record<string, any> = {};
    for (const tool of toolsArray) {
      tools[tool.name] = tool;
    }

    expect(tools.ls).toBeDefined();
    expect(tools.ls.description).toBe("Charmander");
    expect(tools.read_file).toBeDefined();
    expect(tools.read_file.description).toBe("Bulbasaur");
    expect(tools.write_file).toBeDefined();
    expect(tools.write_file.description).toBe(
      WRITE_FILE_TOOL_DESCRIPTION +
        WRITE_FILE_TOOL_DESCRIPTION_LONGTERM_SUPPLEMENT
    );
    expect(tools.edit_file).toBeDefined();
    expect(tools.edit_file.description).toBe("Squirtle");
  });

  it(
    "should list longterm memory files without path",
    { timeout: 60000 },
    async () => {
      const checkpointer = new MemorySaver();
      const store = new InMemoryStore();

      // Add files to store
      await store.put(["filesystem"], "/test.txt", {
        content: ["Hello world"],
        created_at: "2021-01-01",
        modified_at: "2021-01-01",
      });
      await store.put(["filesystem"], "/pokemon/charmander.txt", {
        content: ["Ember"],
        created_at: "2021-01-01",
        modified_at: "2021-01-01",
      });

      const agent = createAgent({
        model: SAMPLE_MODEL,
        middleware: [
          createFilesystemMiddleware({
            longTermMemory: true,
          }),
        ],
        checkpointer,
        store,
      });

      const config = { configurable: { thread_id: uuidv4() } };
      const response = await agent.invoke(
        {
          messages: [new HumanMessage("List all of your files")],
          files: {
            "/pizza.txt": {
              content: ["Hello world"],
              created_at: "2021-01-01",
              modified_at: "2021-01-01",
            },
            "/pokemon/squirtle.txt": {
              content: ["Splash"],
              created_at: "2021-01-01",
              modified_at: "2021-01-01",
            },
          },
        },
        config
      );

      const messages = response.messages;
      const lsMessage = messages.find(
        (msg: any) => msg._getType() === "tool" && msg.name === "ls"
      );

      expect(lsMessage).toBeDefined();
      const lsContent = lsMessage!.content.toString();
      expect(lsContent).toContain("/pizza.txt");
      expect(lsContent).toContain("/pokemon/squirtle.txt");
      expect(lsContent).toContain("/memories/test.txt");
      expect(lsContent).toContain("/memories/pokemon/charmander.txt");
    }
  );

  it(
    "should list longterm memory files with path filter",
    { timeout: 60000 },
    async () => {
      const checkpointer = new MemorySaver();
      const store = new InMemoryStore();

      await store.put(["filesystem"], "/test.txt", {
        content: ["Hello world"],
        created_at: "2021-01-01",
        modified_at: "2021-01-01",
      });
      await store.put(["filesystem"], "/pokemon/charmander.txt", {
        content: ["Ember"],
        created_at: "2021-01-01",
        modified_at: "2021-01-01",
      });

      const agent = createAgent({
        model: SAMPLE_MODEL,
        middleware: [
          createFilesystemMiddleware({
            longTermMemory: true,
          }),
        ],
        checkpointer,
        store,
      });

      const config = { configurable: { thread_id: uuidv4() } };
      const response = await agent.invoke(
        {
          messages: [new HumanMessage("List all files in /pokemon")],
          files: {
            "/pizza.txt": {
              content: ["Hello world"],
              created_at: "2021-01-01",
              modified_at: "2021-01-01",
            },
            "/pokemon/squirtle.txt": {
              content: ["Splash"],
              created_at: "2021-01-01",
              modified_at: "2021-01-01",
            },
          },
        },
        config
      );

      const messages = response.messages;
      const lsMessage = messages.find(
        (msg: any) => msg._getType() === "tool" && msg.name === "ls"
      );

      expect(lsMessage).toBeDefined();
      const lsContent = lsMessage!.content.toString();
      expect(lsContent).toContain("/pokemon/squirtle.txt");
      expect(lsContent).toContain("/memories/pokemon/charmander.txt");
      expect(lsContent).not.toContain("/pizza.txt");
    }
  );

  it("should read longterm memory local file", { timeout: 60000 }, async () => {
    const checkpointer = new MemorySaver();
    const store = new InMemoryStore();

    const agent = createAgent({
      model: SAMPLE_MODEL,
      middleware: [
        createFilesystemMiddleware({
          longTermMemory: true,
        }),
      ],
      checkpointer,
      store,
    });

    const config = { configurable: { thread_id: uuidv4() } };
    const response = await agent.invoke(
      {
        messages: [new HumanMessage("Read the file /pizza.txt")],
        files: {
          "/pizza.txt": {
            content: ["Pepperoni is the best"],
            created_at: "2021-01-01",
            modified_at: "2021-01-01",
          },
        },
      },
      config
    );

    const messages = response.messages;
    const readMessage = messages.find(
      (msg: any) => msg._getType() === "tool" && msg.name === "read_file"
    );

    expect(readMessage).toBeDefined();
    expect(readMessage!.content.toString()).toContain("Pepperoni is the best");
  });

  it("should read longterm memory store file", { timeout: 60000 }, async () => {
    const checkpointer = new MemorySaver();
    const store = new InMemoryStore();

    await store.put(["filesystem"], "/test.txt", {
      content: ["Hello from store"],
      created_at: "2021-01-01",
      modified_at: "2021-01-01",
    });

    const agent = createAgent({
      model: SAMPLE_MODEL,
      middleware: [
        createFilesystemMiddleware({
          longTermMemory: true,
        }),
      ],
      checkpointer,
      store,
    });

    const config = { configurable: { thread_id: uuidv4() } };
    const response = await agent.invoke(
      {
        messages: [new HumanMessage("Read the file /memories/test.txt")],
      },
      config
    );

    const messages = response.messages;
    const readMessage = messages.find(
      (msg: any) => msg._getType() === "tool" && msg.name === "read_file"
    );

    expect(readMessage).toBeDefined();
    expect(readMessage!.content.toString()).toContain("Hello from store");
  });

  it("should write to longterm memory", { timeout: 60000 }, async () => {
    const checkpointer = new MemorySaver();
    const store = new InMemoryStore();

    const agent = createAgent({
      model: SAMPLE_MODEL,
      middleware: [
        createFilesystemMiddleware({
          longTermMemory: true,
        }),
      ],
      checkpointer,
      store,
    });

    const config = { configurable: { thread_id: uuidv4() } };
    const response = await agent.invoke(
      {
        messages: [
          new HumanMessage(
            "Write 'persistent data' to /memories/persistent.txt"
          ),
        ],
      },
      config
    );

    // Verify file was written to store
    const items = await store.search(["filesystem"]);
    const persistentFile = items.find((item) => item.key === "/persistent.txt");

    expect(persistentFile).toBeDefined();
    expect((persistentFile!.value as any).content).toContain("persistent data");
  });

  it(
    "should fail to write to existing store file",
    { timeout: 60000 },
    async () => {
      const checkpointer = new MemorySaver();
      const store = new InMemoryStore();

      await store.put(["filesystem"], "/existing.txt", {
        content: ["Already exists"],
        created_at: "2021-01-01",
        modified_at: "2021-01-01",
      });

      const agent = createAgent({
        model: SAMPLE_MODEL,
        middleware: [
          createFilesystemMiddleware({
            longTermMemory: true,
          }),
        ],
        checkpointer,
        store,
      });

      const config = { configurable: { thread_id: uuidv4() } };
      const response = await agent.invoke(
        {
          messages: [
            new HumanMessage("Write 'new data' to /memories/existing.txt"),
          ],
        },
        config
      );

      const messages = response.messages;
      const writeMessage = messages.find(
        (msg: any) => msg._getType() === "tool" && msg.name === "write_file"
      );

      expect(writeMessage).toBeDefined();
      expect(writeMessage!.content.toString()).toContain("already exists");
    }
  );

  it("should edit longterm memory file", { timeout: 60000 }, async () => {
    const checkpointer = new MemorySaver();
    const store = new InMemoryStore();

    await store.put(["filesystem"], "/editable.txt", {
      content: ["Line 1", "Line 2", "Line 3"],
      created_at: "2021-01-01",
      modified_at: "2021-01-01",
    });

    const agent = createAgent({
      model: SAMPLE_MODEL,
      middleware: [
        createFilesystemMiddleware({
          longTermMemory: true,
        }),
      ],
      checkpointer,
      store,
    });

    const config = { configurable: { thread_id: uuidv4() } };
    const response = await agent.invoke(
      {
        messages: [
          new HumanMessage(
            "Edit /memories/editable.txt: replace 'Line 2' with 'Modified Line 2'"
          ),
        ],
      },
      config
    );

    // Verify file was edited in store
    const items = await store.search(["filesystem"]);
    const editedFile = items.find((item) => item.key === "/editable.txt");

    expect(editedFile).toBeDefined();
    expect((editedFile!.value as any).content).toContain("Modified Line 2");
  });

  it(
    "should handle tool results exceeding token limit",
    { timeout: 60000 },
    async () => {
      const agent = createDeepAgent({
        tools: [getNbaStandings],
        model: SAMPLE_MODEL,
      });

      const response = await agent.invoke({
        messages: [new HumanMessage("Get NBA standings")],
      });

      // Check if large result was evicted to filesystem
      const files = response.files || {};
      const largeResultFiles = Object.keys(files).filter((f) =>
        f.includes("/large_tool_results/")
      );

      expect(largeResultFiles.length).toBeGreaterThan(0);
    }
  );

  it(
    "should handle tool results with custom token limit",
    { timeout: 60000 },
    async () => {
      const agent = createAgent({
        model: SAMPLE_MODEL,
        middleware: [
          createFilesystemMiddleware({
            longTermMemory: false,
            toolTokenLimitBeforeEvict: 100, // Very low limit to trigger eviction
          }),
        ],
        tools: [getNflStandings] as any,
      });

      const response = await agent.invoke({
        messages: [new HumanMessage("Get NFL standings")],
      });

      // Check if result was evicted with custom limit
      const files = response.files || {};
      const largeResultFiles = Object.keys(files).filter((f) =>
        f.includes("/large_tool_results/")
      );

      expect(largeResultFiles.length).toBeGreaterThan(0);
    }
  );

  it(
    "should handle Command return with tool call",
    { timeout: 60000 },
    async () => {
      const agent = createDeepAgent({
        tools: [getPremierLeagueStandings],
        model: SAMPLE_MODEL,
      });

      const response = await agent.invoke({
        messages: [new HumanMessage("Get premier league standings")],
      });

      // Command returns files and research state
      expect(response.files).toBeDefined();
      expect(response.files["/test.txt"]).toBeDefined();
      expect(response.research).toBe("extra_value");
    }
  );

  it(
    "should handle Command with existing state",
    { timeout: 60000 },
    async () => {
      const agent = createDeepAgent({
        tools: [getLaLigaStandings],
        model: SAMPLE_MODEL,
      });

      const response = await agent.invoke({
        messages: [new HumanMessage("Get la liga standings")],
        files: {
          "/existing.txt": {
            content: ["Existing file"],
            created_at: "2021-01-01",
            modified_at: "2021-01-01",
          },
        },
      });

      // Existing files should be preserved
      expect(response.files["/existing.txt"]).toBeDefined();
      expect(response.files["/existing.txt"].content).toContain(
        "Existing file"
      );
    }
  );
});
