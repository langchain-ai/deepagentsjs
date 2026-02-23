import { agent } from "./agent.js";
import { AIMessageChunk, HumanMessage } from "@langchain/core/messages";

const query =
  process.argv.slice(2).join(" ") ||
  "Compare React vs Vue vs Svelte for building enterprise dashboards. Only call async subagents, don't do any work yourself.";

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
};

const AGENT_COLORS = [
  COLORS.cyan,
  COLORS.green,
  COLORS.yellow,
  COLORS.magenta,
  COLORS.blue,
];

type AgentPanel = {
  label: string;
  color: string;
  tokens: string[];
  done: boolean;
};

const subagents = new Map<string, AgentPanel>();
let supervisorTokens: string[] = [];
let supervisorDone = false;
let colorIdx = 0;

function extractContent(msg: AIMessageChunk): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b) => b.type === "text")
      .map((b) => ("text" in b ? b.text : ""))
      .join("");
  }
  return "";
}

function getSubagentKey(ns: string[]): string | null {
  const toolsEntry = ns.find((s) => s.startsWith("tools:"));
  return toolsEntry || null;
}

function getOrCreateSubagent(key: string): AgentPanel {
  if (!subagents.has(key)) {
    subagents.set(key, {
      label: `subagent-${subagents.size + 1}`,
      color: AGENT_COLORS[colorIdx++ % AGENT_COLORS.length],
      tokens: [],
      done: false,
    });
  }
  return subagents.get(key)!;
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length <= width) {
      lines.push(raw);
    } else {
      let remaining = raw;
      while (remaining.length > width) {
        let breakAt = remaining.lastIndexOf(" ", width);
        if (breakAt <= 0) breakAt = width;
        lines.push(remaining.slice(0, breakAt));
        remaining = remaining.slice(breakAt).trimStart();
      }
      if (remaining) lines.push(remaining);
    }
  }
  return lines;
}

function render() {
  const termWidth = process.stdout.columns || 120;
  const termHeight = process.stdout.rows || 40;

  const sections: string[] = [];

  const headerLine = `${COLORS.bold}${COLORS.white}  Async Subagents Demo${COLORS.reset}`;
  sections.push(headerLine);
  sections.push(`${COLORS.dim}${"─".repeat(termWidth)}${COLORS.reset}`);

  if (subagents.size > 0) {
    const agentEntries = [...subagents.values()];
    const panelWidth = Math.min(
      Math.floor((termWidth - agentEntries.length + 1) / agentEntries.length),
      60,
    );
    const contentWidth = panelWidth - 4;

    const panelLines: string[][] = [];
    let maxLines = 0;

    for (const a of agentEntries) {
      const status = a.done
        ? `${COLORS.green}✓ done${COLORS.reset}`
        : `${COLORS.yellow}⟳ running${COLORS.reset}`;
      const header = `${a.color}${COLORS.bold}${a.label}${COLORS.reset} ${status}`;

      const text = a.tokens.join("");
      const tail = text.slice(-contentWidth * 12);
      const wrapped = wrapText(tail, contentWidth);
      const visibleLines = wrapped.slice(-15);

      const lines = [
        header,
        `${COLORS.dim}${"─".repeat(panelWidth)}${COLORS.reset}`,
      ];
      for (const l of visibleLines) {
        lines.push(`  ${l}`);
      }
      panelLines.push(lines);
      if (lines.length > maxLines) maxLines = lines.length;
    }

    for (let i = 0; i < maxLines; i++) {
      const row = panelLines
        .map((lines) => {
          const line = lines[i] || "";
          const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
          const pad = Math.max(0, panelWidth - stripped.length);
          return line + " ".repeat(pad);
        })
        .join(`${COLORS.dim}│${COLORS.reset}`);
      sections.push(row);
    }

    sections.push(`${COLORS.dim}${"─".repeat(termWidth)}${COLORS.reset}`);
  }

  const supStatus = supervisorDone
    ? `${COLORS.green}✓ done${COLORS.reset}`
    : `${COLORS.yellow}⟳ running${COLORS.reset}`;
  sections.push(
    `${COLORS.bold}${COLORS.white}  Supervisor${COLORS.reset} ${supStatus}`,
  );
  sections.push(`${COLORS.dim}${"─".repeat(termWidth)}${COLORS.reset}`);

  const supText = supervisorTokens.join("");
  const supContentWidth = termWidth - 4;
  const supWrapped = wrapText(supText, supContentWidth);

  const availableForSup = termHeight - sections.length - 2;
  const supVisible = supWrapped.slice(-Math.max(availableForSup, 5));
  for (const l of supVisible) {
    sections.push(`  ${l}`);
  }

  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(sections.join("\n") + "\n");
}

async function main() {
  console.log(`${COLORS.bold}Query:${COLORS.reset} ${query}\n`);

  const stream = await agent.stream(
    { messages: [new HumanMessage(query)] },
    {
      streamMode: ["messages"] as const,
      subgraphs: true,
      recursionLimit: 150,
    },
  );

  const renderInterval = setInterval(render, 100);

  for await (const chunk of stream) {
    const [ns, mode, data] = chunk as [string[], string, [any, any]];

    if (mode !== "messages") continue;

    const [msgChunk] = data;
    if (!AIMessageChunk.isInstance(msgChunk)) continue;

    const content = extractContent(msgChunk);
    if (!content) continue;

    const subagentKey = getSubagentKey(ns);
    if (subagentKey) {
      getOrCreateSubagent(subagentKey).tokens.push(content);
    } else {
      supervisorTokens.push(content);
    }
  }

  supervisorDone = true;
  for (const a of [...subagents.values()]) a.done = true;
  clearInterval(renderInterval);
  render();

  console.log(
    `\n${COLORS.dim}${"─".repeat(process.stdout.columns || 120)}${COLORS.reset}`,
  );
  console.log(`${COLORS.green}${COLORS.bold}✓ Complete${COLORS.reset}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
