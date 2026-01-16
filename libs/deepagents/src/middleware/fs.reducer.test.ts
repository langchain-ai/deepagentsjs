import { describe, it, expect } from "vitest";
import { schemaMetaRegistry } from "@langchain/langgraph/zod";
import { getInteropZodObjectShape } from "@langchain/core/utils/types";
import { createFilesystemMiddleware } from "./fs.js";

describe("Filesystem Middleware Reducer Registration", () => {
  it("should register files reducer with LangGraph schemaMetaRegistry", () => {
    // Create the middleware to ensure the schema is defined
    const middleware = createFilesystemMiddleware();

    // Get the state schema from the middleware
    const stateSchema = middleware.stateSchema;
    expect(stateSchema).toBeDefined();
    if (!stateSchema) throw new Error("stateSchema is undefined");

    // Get the shape of the state schema
    const shape = getInteropZodObjectShape(stateSchema);
    expect(shape).toHaveProperty("files");

    // The key test: LangGraph's schemaMetaRegistry should have metadata for the files field
    const filesSchema = shape.files;
    const meta = schemaMetaRegistry.get(filesSchema);

    // This is what fails currently - meta is undefined because .meta() stores
    // in Zod's globalRegistry, not LangGraph's schemaMetaRegistry
    expect(meta).toBeDefined();
    expect(meta?.reducer).toBeDefined();
    expect(typeof meta?.reducer?.fn).toBe("function");
  });

  it("should use BinaryOperatorAggregate channel for files, not LastValue", () => {
    // Create the middleware
    const middleware = createFilesystemMiddleware();
    const stateSchema = middleware.stateSchema;
    expect(stateSchema).toBeDefined();
    if (!stateSchema) throw new Error("stateSchema is undefined");

    // Get channels that LangGraph will create for this schema
    const channels = schemaMetaRegistry.getChannelsForSchema(stateSchema);

    // The files channel should be a BinaryOperatorAggregate (merge reducer)
    // not a LastValue (which only accepts one value per step)
    const filesChannel = channels.files;

    // BinaryOperatorAggregate has a 'func' property, LastValue doesn't
    // This tests that the reducer is properly recognized
    expect(filesChannel).toBeDefined();
    expect(filesChannel.lc_graph_name).toBe("BinaryOperatorAggregate");
  });
});
