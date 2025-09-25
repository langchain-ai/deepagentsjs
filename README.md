# 🧠🤖 Deep Agents

Using an LLM to call tools in a loop is the simplest form of an agent. This architecture, however, can yield agents that are "shallow" and fail to plan and act over longer, more complex tasks. Applications like "Deep Research", "Manus", and "Claude Code" have gotten around this limitation by implementing a combination of four things: a planning tool, sub agents, access to a file system, and a detailed prompt.

`deepagents` is a TypeScript package that implements these in a general purpose way so that you can easily create a Deep Agent for your application.

> ![TIP]
> Looking for the Python version of this package? See [here: hwchase17/deepagents](https://github.com/hwchase17/deepagents)

## Installation

```bash
npm install deepagents
```

## Usage

You can find a full example for how to use this agent in [research-agent.ts](/examples/research/research-agent.ts):

```ts
const agent = createDeepAgent({
  model: new ChatAnthropic({
    model: "claude-3-5-sonnet-20240620",
    temperature: 0,
  }),
  tools: [internetSearch],
  instructions: researchInstructions,
  subagents: [critiqueSubAgent, researchSubAgent],
});

// Invoke the agent
const result = await agent.invoke({
    messages: [{ role: "user", content: "what is langgraph?" }],
}, { recursionLimit: 1000 });

console.log("🎉 Finished!")
console.log(`\n\nAgent ToDo List:\n${result.todos.map((todo) => ` - ${todo.content} (${todo.status})`).join("\n")}`);
console.log(`\n\nAgent Files:\n${Object.entries(result.files).map(([key, value]) => ` - ${key}: ${value}`).join("\n")}`);
```

Which will return:

```
🎉 Finished!

Agent ToDo List:
 - Research LangGraph using the research-agent (completed)
 - Write a comprehensive report on LangGraph (completed)
 - Review and critique the report using the critique-agent (completed)
 - Make necessary revisions to the report (completed)

Agent Files:
 - /question.txt: What is LangGraph?
 - /final_report.md: # What is LangGraph? ...
```

## Learn more

For more information, check out our docs: [https://docs.langchain.com/labs/deep-agents/overview](https://docs.langchain.com/labs/deep-agents/overview)
