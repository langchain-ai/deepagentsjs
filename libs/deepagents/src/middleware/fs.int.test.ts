import { describe, it, expect } from "vitest";
import { createAgent } from "langchain";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent } from "../index.js";
import {
  createFilesystemMiddleware,
  WRITE_FILE_TOOL_DESCRIPTION,
} from "./fs.js";
import {
  StateBackend,
  StoreBackend,
  CompositeBackend,
} from "../backends/index.js";
import { v4 as uuidv4 } from "uuid";
import {
  SAMPLE_MODEL,
  getPremierLeagueStandings,
  getLaLigaStandings,
  getNbaStandings,
} from "../testing/utils.js";

describe("Filesystem Middleware Integration Tests", () => {
  it.concurrent.each([
    { useComposite: false, label: "StateBackend" },
    { useComposite: true, label: "CompositeBackend" },
  ])(
    "should override filesystem system prompt ($label)",
    { timeout: 90 * 1000 }, // 90s
    async ({ useComposite }) => {
      const checkpointer = useComposite ? new MemorySaver() : undefined;
      const store = useComposite ? new InMemoryStore() : undefined;

      const backend = useComposite
        ? (stateAndStore: any) =>
            new CompositeBackend(new StateBackend(stateAndStore), {
              "/memories/": new StoreBackend(stateAndStore),
            })
        : undefined; // Use default StateBackend

      const filesystemMiddleware = createFilesystemMiddleware({
        backend,
        systemPrompt:
          "In every single response, you must say the word 'pokemon'! You love it!",
      });

      const agent = createAgent({
        model: SAMPLE_MODEL,
        middleware: [filesystemMiddleware],
        checkpointer,
        store,
      });

      const config = useComposite
        ? { configurable: { thread_id: uuidv4() } }
        : undefined;
      const response = await agent.invoke(
        {
          messages: [new HumanMessage("What do you like?")],
        },
        config,
      );

      const lastMessage = response.messages[response.messages.length - 1];
      expect(lastMessage.content.toString().toLowerCase()).toMatch(
        /pok[ée]mon/,
      );
    },
  );

  it.concurrent.each([
    { useComposite: false, label: "StateBackend" },
    { useComposite: true, label: "CompositeBackend" },
  ])(
    "should override filesystem tool descriptions ($label)",
    { timeout: 90 * 1000 }, // 90s
    async ({ useComposite }) => {
      const checkpointer = useComposite ? new MemorySaver() : undefined;
      const store = useComposite ? new InMemoryStore() : undefined;

      const backend = useComposite
        ? (stateAndStore: any) =>
            new CompositeBackend(new StateBackend(stateAndStore), {
              "/memories/": new StoreBackend(stateAndStore),
            })
        : undefined;

      const agent = createAgent({
        model: SAMPLE_MODEL,
        middleware: [
          createFilesystemMiddleware({
            backend,
            customToolDescriptions: {
              ls: "Charmander",
              read_file: "Bulbasaur",
              edit_file: "Squirtle",
            },
          }),
        ] as const,
        tools: [],
        checkpointer,
        store,
      });

      const toolsArray = (agent as any).graph?.nodes?.tools?.bound?.tools || [];
      const tools: Record<string, any> = {};
      for (const tool of toolsArray) {
        tools[tool.name] = tool;
      }

      expect(tools).toMatchObject({
        ls: { description: "Charmander" },
        read_file: { description: "Bulbasaur" },
        write_file: {
          description: WRITE_FILE_TOOL_DESCRIPTION,
        },
        edit_file: {
          description: "Squirtle",
        },
      });
    },
  );

  it.concurrent(
    "should list longterm memory files without path",
    { timeout: 90 * 1000 }, // 90s
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
            backend: (stateAndStore: any) =>
              new CompositeBackend(new StateBackend(stateAndStore), {
                "/memories/": new StoreBackend(stateAndStore),
              }),
          }),
        ] as const,
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
        } as any,
        config,
      );

      const messages = response.messages;
      const lsMessage = messages.find(
        (msg) => ToolMessage.isInstance(msg) && msg.name === "ls",
      );

      expect(lsMessage).toBeDefined();
      const lsContent = lsMessage!.content.toString();
      expect(lsContent).toContain("/pizza.txt");
      expect(lsContent).toContain("/pokemon/");
      expect(lsContent).toContain("/memories/");
    },
  );

  it.concurrent(
    "should list longterm memory files with path filter",
    { timeout: 90 * 1000 }, // 90s
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
            backend: (stateAndStore: any) =>
              new CompositeBackend(new StateBackend(stateAndStore), {
                "/memories/": new StoreBackend(stateAndStore),
              }),
          }),
        ] as const,
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
        } as any,
        config,
      );

      const messages = response.messages;
      const lsMessage = messages.find(
        (msg) => ToolMessage.isInstance(msg) && msg.name === "ls",
      );

      expect(lsMessage).toBeDefined();
      const lsContent = lsMessage!.content.toString();
      expect(lsContent).toContain("/pokemon/squirtle.txt");
      expect(lsContent).not.toContain("/memories/pokemon/charmander.txt");
      expect(lsContent).not.toContain("/pizza.txt");
    },
  );

  it.concurrent(
    "should read longterm memory local file",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const checkpointer = new MemorySaver();
      const store = new InMemoryStore();

      const agent = createAgent({
        model: SAMPLE_MODEL,
        middleware: [
          createFilesystemMiddleware({
            backend: (stateAndStore: any) =>
              new CompositeBackend(new StateBackend(stateAndStore), {
                "/memories/": new StoreBackend(stateAndStore),
              }),
          }),
        ] as const,
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
        } as any,
        config,
      );

      const messages = response.messages;
      const readMessage = messages.find(
        (msg) => ToolMessage.isInstance(msg) && msg.name === "read_file",
      );

      expect(readMessage).toBeDefined();
      expect(readMessage!.content.toString()).toContain(
        "Pepperoni is the best",
      );
    },
  );

  it.concurrent(
    "should read longterm memory store file",
    { timeout: 90 * 1000 }, // 90s
    async () => {
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
            backend: (stateAndStore: any) =>
              new CompositeBackend(new StateBackend(stateAndStore), {
                "/memories/": new StoreBackend(stateAndStore),
              }),
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
        config,
      );

      const messages = response.messages;
      const readMessage = messages.find(
        (msg) => ToolMessage.isInstance(msg) && msg.name === "read_file",
      );

      expect(readMessage).toBeDefined();
      expect(readMessage!.content.toString()).toContain("Hello from store");
    },
  );

  it.concurrent(
    "should write to longterm memory",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const checkpointer = new MemorySaver();
      const store = new InMemoryStore();

      const agent = createAgent({
        model: SAMPLE_MODEL,
        middleware: [
          createFilesystemMiddleware({
            backend: (stateAndStore: any) =>
              new CompositeBackend(new StateBackend(stateAndStore), {
                "/memories/": new StoreBackend(stateAndStore),
              }),
          }),
        ],
        checkpointer,
        store,
      });

      const config = { configurable: { thread_id: uuidv4() } };
      await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Write 'persistent data' to /memories/persistent.txt",
            ),
          ],
        },
        config,
      );

      // Verify file was written to store
      const items = await store.search(["filesystem"]);
      const persistentFile = items.find(
        (item) => item.key === "/persistent.txt",
      );

      expect(persistentFile).toBeDefined();
      expect((persistentFile!.value as any).content).toContain(
        "persistent data",
      );
    },
  );

  it.concurrent(
    "should fail to write to existing store file",
    { timeout: 90 * 1000 }, // 90s
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
            backend: (stateAndStore: any) =>
              new CompositeBackend(new StateBackend(stateAndStore), {
                "/memories/": new StoreBackend(stateAndStore),
              }),
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
        config,
      );

      const messages = response.messages;
      const writeMessage = messages.find(
        (msg) => ToolMessage.isInstance(msg) && msg.name === "write_file",
      );

      expect(writeMessage).toBeDefined();
      expect(writeMessage!.content.toString()).toContain("already exists");
    },
  );

  it.concurrent(
    "should edit longterm memory file",
    { timeout: 90 * 1000 }, // 90s
    async () => {
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
            backend: (stateAndStore: any) =>
              new CompositeBackend(new StateBackend(stateAndStore), {
                "/memories/": new StoreBackend(stateAndStore),
              }),
          }),
        ],
        checkpointer,
        store,
      });

      const config = { configurable: { thread_id: uuidv4() } };
      await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Edit /memories/editable.txt: replace 'Line 2' with 'Modified Line 2'",
            ),
          ],
        },
        config,
      );

      // Verify file was edited in store
      const items = await store.search(["filesystem"]);
      const editedFile = items.find((item) => item.key === "/editable.txt");

      expect(editedFile).toBeDefined();
      expect((editedFile!.value as any).content).toContain("Modified Line 2");
    },
  );

  it.concurrent(
    "should handle tool results exceeding token limit",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const checkpointer = new MemorySaver();
      const store = new InMemoryStore();

      const agent = createAgent({
        model: SAMPLE_MODEL,
        tools: [getNbaStandings],
        middleware: [
          createFilesystemMiddleware({
            backend: (stateAndStore: any) =>
              new CompositeBackend(new StateBackend(stateAndStore), {
                "/memories/": new StoreBackend(stateAndStore),
              }),
          }),
        ],
        checkpointer,
        store,
      });

      const config = { configurable: { thread_id: uuidv4() } };
      const response = await agent.invoke(
        {
          messages: [new HumanMessage("Get NBA standings")],
        },
        config,
      );

      const files = (response as any).files || {};
      const largeResultFiles = Object.keys(files).filter((f) =>
        f.includes("/large_tool_results/"),
      );

      expect(largeResultFiles.length).toBeGreaterThan(0);
    },
  );

  it.concurrent(
    "should handle tool results with custom token limit",
    { timeout: 120000 },
    async () => {
      const checkpointer = new MemorySaver();
      const store = new InMemoryStore();

      const agent = createAgent({
        model: SAMPLE_MODEL,
        tools: [getNbaStandings],
        middleware: [
          createFilesystemMiddleware({
            backend: (stateAndStore: any) =>
              new CompositeBackend(new StateBackend(stateAndStore), {
                "/memories/": new StoreBackend(stateAndStore),
              }),
            toolTokenLimitBeforeEvict: 10000, // Low limit to trigger eviction
          }),
        ],
        checkpointer,
        store,
      });

      const config = {
        configurable: { thread_id: uuidv4() },
        recursionLimit: 1000,
      };
      const response = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Get NBA standings, if the information from the tool is not good, then just return, only try reading file 1 time max.",
            ),
          ],
        },
        config,
      );

      // Check if result was evicted with custom limit
      const files = (response as any).files || {};
      const largeResultFiles = Object.keys(files).filter((f) =>
        f.includes("/large_tool_results/"),
      );

      expect(largeResultFiles.length).toBeGreaterThan(0);
    },
  );

  it.concurrent(
    "should handle Command return with tool call",
    { timeout: 90 * 1000 }, // 90s
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
      expect(response.files!["/test.txt"]).toBeDefined();
    },
  );

  it.concurrent(
    "should handle Command with existing state",
    { timeout: 90 * 1000 }, // 90s
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
      expect(response.files).toBeDefined();
      expect(response.files!["/existing.txt"]).toBeDefined();
      expect(response.files!["/existing.txt"]?.content).toContain(
        "Existing file",
      );
    },
  );

  it.concurrent(
    "should fail to write to existing local file",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const checkpointer = new MemorySaver();
      const store = new InMemoryStore();

      const agent = createAgent({
        model: SAMPLE_MODEL,
        middleware: [
          createFilesystemMiddleware({
            backend: (stateAndStore: any) =>
              new CompositeBackend(new StateBackend(stateAndStore), {
                "/memories/": new StoreBackend(stateAndStore),
              }),
          }),
        ],
        checkpointer,
        store,
      });

      const config = { configurable: { thread_id: uuidv4() } };
      const response = await agent.invoke(
        {
          messages: [new HumanMessage("Write 'new content' to /existing.txt")],
          files: {
            "/existing.txt": {
              content: ["Already exists"],
              created_at: "2021-01-01",
              modified_at: "2021-01-01",
            },
          },
        } as any,
        config,
      );

      const messages = response.messages;
      const writeMessage = messages.find(
        (msg) => ToolMessage.isInstance(msg) && msg.name === "write_file",
      );

      expect(writeMessage).toBeDefined();
      expect(writeMessage!.content.toString()).toContain("already exists");
    },
  );

  it.concurrent(
    "should perform glob search in shortterm memory only",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const checkpointer = new MemorySaver();

      const agent = createAgent({
        model: SAMPLE_MODEL,
        middleware: [createFilesystemMiddleware()],
        checkpointer,
      });

      const config = { configurable: { thread_id: uuidv4() } };
      const response = await agent.invoke(
        {
          messages: [new HumanMessage("Use glob to find all Python files")],
          files: {
            "/test.py": {
              content: ["import os"],
              created_at: "2021-01-01",
              modified_at: "2021-01-01",
            },
            "/main.py": {
              content: ["def main(): pass"],
              created_at: "2021-01-01",
              modified_at: "2021-01-01",
            },
            "/readme.txt": {
              content: ["Documentation"],
              created_at: "2021-01-01",
              modified_at: "2021-01-01",
            },
          },
        } as any,
        config,
      );

      const messages = response.messages;
      const globMessage = messages.find(
        (msg) => ToolMessage.isInstance(msg) && msg.name === "glob",
      );

      expect(globMessage).toBeDefined();
      const globContent = globMessage!.content.toString();
      expect(globContent).toContain("/test.py");
      expect(globContent).toContain("/main.py");
      expect(globContent).not.toContain("/readme.txt");
    },
  );

  it.concurrent(
    "should perform glob search in longterm memory only",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const checkpointer = new MemorySaver();
      const store = new InMemoryStore();

      await store.put(["filesystem"], "/config.py", {
        content: ["DEBUG = True"],
        created_at: "2021-01-01",
        modified_at: "2021-01-01",
      });
      await store.put(["filesystem"], "/settings.py", {
        content: ["SECRET_KEY = 'abc'"],
        created_at: "2021-01-01",
        modified_at: "2021-01-01",
      });
      await store.put(["filesystem"], "/notes.txt", {
        content: ["Important notes"],
        created_at: "2021-01-01",
        modified_at: "2021-01-01",
      });

      const agent = createAgent({
        model: SAMPLE_MODEL,
        middleware: [
          createFilesystemMiddleware({
            backend: (stateAndStore: any) =>
              new CompositeBackend(new StateBackend(stateAndStore), {
                "/memories/": new StoreBackend(stateAndStore),
              }),
          }),
        ],
        checkpointer,
        store,
      });

      const config = { configurable: { thread_id: uuidv4() } };
      const response = await agent.invoke(
        {
          messages: [
            new HumanMessage("Use glob to find all Python files in /memories"),
          ],
          files: {},
        } as any,
        config,
      );

      const messages = response.messages;
      const globMessage = messages.find(
        (msg) => ToolMessage.isInstance(msg) && msg.name === "glob",
      );

      expect(globMessage).toBeDefined();
      const globContent = globMessage!.content.toString();
      expect(globContent).toContain("/memories/config.py");
      expect(globContent).toContain("/memories/settings.py");
      expect(globContent).not.toContain("/memories/notes.txt");
    },
  );

  it.concurrent(
    "should perform glob search across mixed memory",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const checkpointer = new MemorySaver();
      const store = new InMemoryStore();

      await store.put(["filesystem"], "/longterm.py", {
        content: ["# Longterm file"],
        created_at: "2021-01-01",
        modified_at: "2021-01-01",
      });
      await store.put(["filesystem"], "/longterm.txt", {
        content: ["Text file"],
        created_at: "2021-01-01",
        modified_at: "2021-01-01",
      });

      const agent = createAgent({
        model: SAMPLE_MODEL,
        middleware: [
          createFilesystemMiddleware({
            backend: (stateAndStore: any) =>
              new CompositeBackend(new StateBackend(stateAndStore), {
                "/memories/": new StoreBackend(stateAndStore),
              }),
          }),
        ],
        checkpointer,
        store,
      });

      const config = { configurable: { thread_id: uuidv4() } };
      const response = await agent.invoke(
        {
          messages: [new HumanMessage("Use glob to find all Python files")],
          files: {
            "/shortterm.py": {
              content: ["# Shortterm file"],
              created_at: "2021-01-01",
              modified_at: "2021-01-01",
            },
            "/shortterm.txt": {
              content: ["Another text file"],
              created_at: "2021-01-01",
              modified_at: "2021-01-01",
            },
          },
        } as any,
        config,
      );

      const messages = response.messages;
      const globMessage = messages.find(
        (msg) => ToolMessage.isInstance(msg) && msg.name === "glob",
      );

      expect(globMessage).toBeDefined();
      const globContent = globMessage!.content.toString();
      expect(globContent).toContain("/shortterm.py");
      expect(globContent).toContain("/memories/longterm.py");
      expect(globContent).not.toContain("/shortterm.txt");
      expect(globContent).not.toContain("/memories/longterm.txt");
    },
  );

  it.concurrent(
    "should perform grep search in shortterm memory only",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const checkpointer = new MemorySaver();

      const agent = createAgent({
        model: SAMPLE_MODEL,
        middleware: [createFilesystemMiddleware()],
        checkpointer,
      });

      const config = { configurable: { thread_id: uuidv4() } };
      const response = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Use grep to find all files containing the word 'import'",
            ),
          ],
          files: {
            "/test.py": {
              content: ["import os", "import sys"],
              created_at: "2021-01-01",
              modified_at: "2021-01-01",
            },
            "/main.py": {
              content: ["def main(): pass"],
              created_at: "2021-01-01",
              modified_at: "2021-01-01",
            },
            "/helper.py": {
              content: ["import json"],
              created_at: "2021-01-01",
              modified_at: "2021-01-01",
            },
          },
        } as any,
        config,
      );

      const messages = response.messages;
      const grepMessage = messages.find(
        (msg) => ToolMessage.isInstance(msg) && msg.name === "grep",
      );

      expect(grepMessage).toBeDefined();
      const grepContent = grepMessage!.content.toString();
      expect(grepContent).toContain("/test.py");
      expect(grepContent).toContain("/helper.py");
      expect(grepContent).not.toContain("/main.py");
    },
  );

  it.concurrent(
    "should perform grep search in longterm memory only",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const checkpointer = new MemorySaver();
      const store = new InMemoryStore();

      await store.put(["filesystem"], "/pokemon/charmander.txt", {
        content: ["Charmander is a fire type", "It evolves into Charmeleon"],
        created_at: "2021-01-01",
        modified_at: "2021-01-01",
      });
      await store.put(["filesystem"], "/pokemon/squirtle.txt", {
        content: ["Squirtle is a water type", "It evolves into Wartortle"],
        created_at: "2021-01-01",
        modified_at: "2021-01-01",
      });
      await store.put(["filesystem"], "/pokemon/bulbasaur.txt", {
        content: ["Bulbasaur is a grass type"],
        created_at: "2021-01-01",
        modified_at: "2021-01-01",
      });

      const agent = createAgent({
        model: SAMPLE_MODEL,
        middleware: [
          createFilesystemMiddleware({
            backend: (stateAndStore: any) =>
              new CompositeBackend(new StateBackend(stateAndStore), {
                "/memories/": new StoreBackend(stateAndStore),
              }),
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
              "Use grep to find all files in the memories directory containing the word 'fire'",
            ),
          ],
          files: {},
        } as any,
        config,
      );

      const messages = response.messages;
      const grepMessage = messages.find(
        (msg) => ToolMessage.isInstance(msg) && msg.name === "grep",
      );

      expect(grepMessage).toBeDefined();
      const grepContent = grepMessage!.content.toString();
      expect(grepContent).toContain("/memories/pokemon/charmander.txt");
      expect(grepContent).not.toContain("/memories/pokemon/squirtle.txt");
      expect(grepContent).not.toContain("/memories/pokemon/bulbasaur.txt");
    },
  );

  it.concurrent(
    "should perform grep search across mixed memory",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const checkpointer = new MemorySaver();
      const store = new InMemoryStore();

      await store.put(["filesystem"], "/longterm_config.py", {
        content: ["DEBUG = True", "TESTING = False"],
        created_at: "2021-01-01",
        modified_at: "2021-01-01",
      });
      await store.put(["filesystem"], "/longterm_settings.py", {
        content: ["SECRET_KEY = 'abc'"],
        created_at: "2021-01-01",
        modified_at: "2021-01-01",
      });

      const agent = createAgent({
        model: SAMPLE_MODEL,
        middleware: [
          createFilesystemMiddleware({
            backend: (stateAndStore: any) =>
              new CompositeBackend(new StateBackend(stateAndStore), {
                "/memories/": new StoreBackend(stateAndStore),
              }),
          }),
        ],
        checkpointer,
        store,
      });

      const config = { configurable: { thread_id: uuidv4() } };
      const response = await agent.invoke(
        {
          messages: [
            new HumanMessage("Use grep to find all files containing 'DEBUG'"),
          ],
          files: {
            "/shortterm_config.py": {
              content: ["DEBUG = False", "VERBOSE = True"],
              created_at: "2021-01-01",
              modified_at: "2021-01-01",
            },
            "/shortterm_main.py": {
              content: ["def main(): pass"],
              created_at: "2021-01-01",
              modified_at: "2021-01-01",
            },
          },
        } as any,
        config,
      );

      const messages = response.messages;
      const grepMessage = messages.find(
        (msg) => ToolMessage.isInstance(msg) && msg.name === "grep",
      );

      expect(grepMessage).toBeDefined();
      const grepContent = grepMessage!.content.toString();
      expect(grepContent).toContain("/shortterm_config.py");
      expect(grepContent).toContain("/memories/longterm_config.py");
      expect(grepContent).not.toContain("/shortterm_main.py");
      expect(grepContent).not.toContain("/memories/longterm_settings.py");
    },
  );

  it.concurrent(
    "should use default backend when no backend specified",
    { timeout: 120000 },
    async () => {
      const checkpointer = new MemorySaver();

      const agent = createAgent({
        model: SAMPLE_MODEL,
        middleware: [createFilesystemMiddleware()],
        checkpointer,
      });

      const config = { configurable: { thread_id: uuidv4() } };

      const response = await agent.invoke(
        {
          messages: [new HumanMessage("Write 'Hello World' to /test.txt")],
        },
        config,
      );

      expect((response as any).files).toBeDefined();
      expect((response as any).files["/test.txt"]).toBeDefined();
      expect((response as any).files["/test.txt"].content).toContain(
        "Hello World",
      );

      const response2 = await agent.invoke(
        {
          messages: [new HumanMessage("Read /test.txt")],
        },
        config,
      );

      const messages = response2.messages;
      const readMessage = messages.find(
        (msg) => ToolMessage.isInstance(msg) && msg.name === "read_file",
      );
      expect(readMessage).toBeDefined();
      expect(readMessage!.content.toString()).toContain("Hello World");
    },
  );

  it.concurrent(
    "should handle longterm memory CRUD across multiple threads",
    { timeout: 120000 },
    async () => {
      const checkpointer = new MemorySaver();
      const store = new InMemoryStore();

      // Pre-populate the store with a test file
      await store.put(["filesystem"], "/pokemon.txt", {
        content: ["Charmander is a fire-type Pokemon"],
        created_at: new Date().toISOString(),
        modified_at: new Date().toISOString(),
      });

      const agent = createDeepAgent({
        backend: (stateAndStore: any) =>
          new CompositeBackend(new StateBackend(stateAndStore), {
            "/memories/": new StoreBackend(stateAndStore),
          }),
        checkpointer,
        store,
      });

      // Read from one thread
      const config1 = { configurable: { thread_id: uuidv4() } };
      const readResponse = await agent.invoke(
        {
          messages: [new HumanMessage("Read /memories/pokemon.txt")],
        },
        config1,
      );

      const readMessages = readResponse.messages;
      const readMessage = readMessages.find(
        (msg) => ToolMessage.isInstance(msg) && msg.name === "read_file",
      );
      expect(readMessage).toBeDefined();
      expect(readMessage!.content.toString()).toContain("Charmander");

      // List from another thread
      const config2 = { configurable: { thread_id: uuidv4() } };
      const listResponse = await agent.invoke(
        {
          messages: [new HumanMessage("List files in /memories")],
        },
        config2,
      );

      const listMessages = listResponse.messages;
      const lsMessage = listMessages.find(
        (msg) => ToolMessage.isInstance(msg) && msg.name === "ls",
      );
      expect(lsMessage).toBeDefined();
      expect(lsMessage!.content.toString()).toContain("/memories/pokemon.txt");

      // Edit from yet another thread
      const config3 = { configurable: { thread_id: uuidv4() } };
      const editResponse = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Edit /memories/pokemon.txt: replace 'fire' with 'blazing'",
            ),
          ],
        },
        config3,
      );

      const editMessages = editResponse.messages;
      const editMessage = editMessages.find(
        (msg) => ToolMessage.isInstance(msg) && msg.name === "edit_file",
      );
      expect(editMessage).toBeDefined();

      // Verify the edit persisted in the store
      const updatedFile = await store.get(["filesystem"], "/pokemon.txt");
      expect(updatedFile).toBeDefined();
      const content = (updatedFile!.value as any).content.join("\n");
      expect(content).toContain("blazing");
    },
  );

  it.concurrent(
    "should handle shortterm memory CRUD in single thread",
    { timeout: 120000 },
    async () => {
      const checkpointer = new MemorySaver();
      const store = new InMemoryStore();

      const agent = createDeepAgent({
        backend: (stateAndStore: any) => new StateBackend(stateAndStore),
        checkpointer,
        store,
      });

      const config = { configurable: { thread_id: uuidv4() } };

      // Write a shortterm memory file
      const writeResponse = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Write a haiku about Charmander to /charmander.txt, use the word 'fiery'",
            ),
          ],
        },
        config,
      );

      const files = writeResponse.files || {};
      expect(files["/charmander.txt"]).toBeDefined();

      // Read the shortterm memory file
      const readResponse = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Read the haiku about Charmander from /charmander.txt",
            ),
          ],
        },
        config,
      );

      const readMessages = readResponse.messages;
      const readMessage = [...readMessages]
        .reverse()
        .find((msg) => ToolMessage.isInstance(msg) && msg.name === "read_file");
      expect(readMessage).toBeDefined();
      expect(
        readMessage!.content.toString().toLowerCase().includes("fiery"),
      ).toBe(true);

      // List all files in shortterm memory
      const listResponse = await agent.invoke(
        {
          messages: [
            new HumanMessage("List all of the files in your filesystem"),
          ],
        },
        config,
      );

      const listMessages = listResponse.messages;
      const lsMessage = listMessages.find(
        (msg) => ToolMessage.isInstance(msg) && msg.name === "ls",
      );
      expect(lsMessage).toBeDefined();
      expect(lsMessage!.content.toString()).toContain("/charmander.txt");

      // Edit the shortterm memory file
      const editResponse = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Edit the haiku about Charmander to use the word 'ember'",
            ),
          ],
        },
        config,
      );

      const editedFiles = editResponse.files || {};
      expect(editedFiles["/charmander.txt"]).toBeDefined();
      const content = editedFiles["/charmander.txt"]?.content.join("\n");
      expect(content?.toLowerCase().includes("ember")).toBe(true);

      // Read again to verify edit
      const verifyResponse = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Read the haiku about Charmander at /charmander.txt",
            ),
          ],
        },
        config,
      );

      const verifyMessages = verifyResponse.messages;
      const verifyReadMessage = [...verifyMessages]
        .reverse()
        .find((msg) => ToolMessage.isInstance(msg) && msg.name === "read_file");
      expect(verifyReadMessage).toBeDefined();
      expect(
        verifyReadMessage!.content.toString().toLowerCase().includes("ember"),
      ).toBe(true);
    },
  );
});
