<script setup lang="ts">
import { computed } from "vue";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { SubagentDiscoverySnapshot } from "@langchain/vue";

import { getReasoningText } from "~/utils/streaming";
import MessageBubble from "./MessageBubble.vue";
import MessageReasoning from "./MessageReasoning.vue";
import SubagentList, { type SubagentCard } from "./SubagentList.vue";
import ToolCall, { type ToolCallView } from "./ToolCall.vue";

type ToolCallLike = {
  name: string;
  args?: Record<string, unknown>;
  id?: string;
};

/** Deep agents delegate to subagents through the built-in `task` tool. */
const TASK_TOOL = "task";

const EMPTY_TOOL_CALL: ToolCallView = {
  id: "",
  name: "",
  args: {},
  status: "complete",
};

const props = defineProps<{
  messages: BaseMessage[];
  /** Whether the surrounding run is streaming — drives reasoning/tool-call state. */
  isLoading?: boolean;
  /**
   * Root-stream subagent snapshots. When provided ("root mode"), `task` tool
   * calls render as inline subagent cards at the point of delegation instead of
   * tool-call chips. In both modes, regular tool calls render as collapsible
   * {@link ToolCall} chips with their result folded in, and standalone tool
   * result messages are hidden.
   */
  subagents?: SubagentDiscoverySnapshot[];
}>();

const emit = defineEmits<{ openSubagent: [id: string] }>();

const rootMode = computed(() => props.subagents != null);

const subagentsById = computed(() => {
  const map = new Map<string, SubagentDiscoverySnapshot>();
  for (const snapshot of props.subagents ?? []) map.set(snapshot.id, snapshot);
  return map;
});

type Item = {
  key: string;
  kind: "reasoning" | "bubble" | "subagents" | "toolcall";
  message: BaseMessage;
  reasoning: string;
  active: boolean;
  cards: SubagentCard[];
  toolCall: ToolCallView;
};

function hasToolCalls(message: BaseMessage): boolean {
  return AIMessage.isInstance(message) && (message.tool_calls?.length ?? 0) > 0;
}

function buildCards(tasks: ToolCallLike[]): SubagentCard[] {
  return tasks.map((call, index) => {
    const snapshot = call.id ? subagentsById.value.get(call.id) : undefined;
    const args = (call.args ?? {}) as Record<string, unknown>;
    return {
      id: call.id ?? `task-${index}`,
      name: snapshot?.name ?? String(args.subagent_type ?? "subagent"),
      task:
        snapshot?.taskInput ??
        (typeof args.description === "string" ? args.description : undefined),
      status: snapshot?.status ?? "running",
      openable: snapshot != null,
    };
  });
}

// Each tool call is folded together with its result message (matched by
// `tool_call_id`) into a single collapsible chip; reasoning renders standalone
// before the answer; and `task` delegations render as subagent cards (root
// mode). Standalone tool result messages are hidden.
const items = computed<Item[]>(() => {
  const result: Item[] = [];

  const resultsByCallId = new Map<string, BaseMessage>();
  for (const message of props.messages) {
    if (message.type !== "tool") continue;
    const id = (message as { tool_call_id?: unknown }).tool_call_id;
    if (typeof id === "string") resultsByCallId.set(id, message);
  }

  props.messages.forEach((message, index) => {
    if (message.type === "tool") return; // folded into its tool-call chip

    if (AIMessage.isInstance(message)) {
      const calls = (message.tool_calls ?? []) as ToolCallLike[];
      const tasks = rootMode.value
        ? calls.filter((call) => call.name === TASK_TOOL)
        : [];
      const chipCalls = rootMode.value
        ? calls.filter((call) => call.name !== TASK_TOOL)
        : calls;

      const reasoning = getReasoningText(message);
      if (reasoning) {
        const active =
          Boolean(props.isLoading) &&
          index === props.messages.length - 1 &&
          !message.text?.trim() &&
          !hasToolCalls(message);
        result.push({
          key: `reason-${message.id ?? index}`,
          kind: "reasoning",
          message,
          reasoning,
          active,
          cards: [],
          toolCall: EMPTY_TOOL_CALL,
        });
      }

      if (message.text?.trim()) {
        result.push({
          key: message.id ?? `m-${index}`,
          kind: "bubble",
          message,
          reasoning: "",
          active: false,
          cards: [],
          toolCall: EMPTY_TOOL_CALL,
        });
      }

      if (tasks.length > 0) {
        result.push({
          key: `task-${message.id ?? index}`,
          kind: "subagents",
          message,
          reasoning: "",
          active: false,
          cards: buildCards(tasks),
          toolCall: EMPTY_TOOL_CALL,
        });
      }

      chipCalls.forEach((call, callIndex) => {
        const resultMessage = call.id ? resultsByCallId.get(call.id) : undefined;
        const errored =
          (resultMessage as { status?: string } | undefined)?.status ===
          "error";
        const view: ToolCallView = {
          id: call.id ?? `${index}-${callIndex}`,
          name: call.name,
          args: call.args ?? {},
          output: resultMessage?.text,
          status: resultMessage
            ? errored
              ? "error"
              : "complete"
            : props.isLoading
              ? "running"
              : "complete",
        };
        result.push({
          key: `tc-${view.id}`,
          kind: "toolcall",
          message,
          reasoning: "",
          active: false,
          cards: [],
          toolCall: view,
        });
      });
      return;
    }

    result.push({
      key: message.id ?? `m-${index}`,
      kind: "bubble",
      message,
      reasoning: "",
      active: false,
      cards: [],
      toolCall: EMPTY_TOOL_CALL,
    });
  });

  return result;
});
</script>

<template>
  <template v-for="item in items" :key="item.key">
    <MessageReasoning
      v-if="item.kind === 'reasoning'"
      :active="item.active"
      :reasoning="item.reasoning"
    />
    <SubagentList
      v-else-if="item.kind === 'subagents'"
      :cards="item.cards"
      @open="emit('openSubagent', $event)"
    />
    <ToolCall v-else-if="item.kind === 'toolcall'" :call="item.toolCall" />
    <MessageBubble v-else :message="item.message" :tool-calls="[]" />
  </template>
</template>
