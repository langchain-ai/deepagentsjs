import { describe, it, expect } from "vitest";
import { transformPackageJson } from "./transformPackageJson.js";
import type { PackageJson } from "../../schema/packageJson.js";
import type { ProviderConfig } from "../../registry/provider.js";

const mockProvider: ProviderConfig = {
  id: "openai",
  title: "OpenAI",
  defaultModel: "openai:gpt-5.4-mini",
  dependency: "@langchain/openai",
  env: [{ name: "OPENAI_API_KEY" }],
};

const allProviderDeps = [
  "@langchain/openai",
  "@langchain/anthropic",
  "@langchain/google-genai",
  "@langchain/fireworks",
];

function makeTemplate(): PackageJson {
  return {
    name: "template-name",
    dependencies: {
      "@langchain/openai": "^1.0.0",
      "react": "^19.0.0",
      "react-dom": "^19.0.0",
    },
    packageManager: "pnpm@10.33.2",
  };
}

describe("transformPackageJson", () => {
  it("sets the project name", () => {
    const result = transformPackageJson(makeTemplate(), {
      projectName: "my-agent",
      provider: mockProvider,
      providerDependencies: allProviderDeps,
    });
    expect(result.name).toBe("my-agent");
  });

  it("strips non-selected provider dependencies from the template", () => {
    const template = makeTemplate();
    template.dependencies["@langchain/anthropic"] = "^1.0.0";
    template.dependencies["@langchain/google-genai"] = "^1.0.0";
    const result = transformPackageJson(template, {
      projectName: "my-agent",
      provider: mockProvider,
      providerDependencies: allProviderDeps,
    });
    expect(result.dependencies).not.toHaveProperty("@langchain/anthropic");
    expect(result.dependencies).not.toHaveProperty("@langchain/google-genai");
    expect(result.dependencies).not.toHaveProperty("@langchain/fireworks");
    
    // Selected provider is re-injected as "latest" after stripping
    expect(result.dependencies).toHaveProperty("@langchain/openai");
  });

  it("removes the packageManager field", () => {
    const result = transformPackageJson(makeTemplate(), {
      projectName: "my-agent",
      provider: mockProvider,
      providerDependencies: allProviderDeps,
    });
    expect(result).not.toHaveProperty("packageManager");
  });
});
