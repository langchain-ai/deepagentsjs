<script setup lang="ts">
import { computed } from "vue";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";

type ToolCallLike = {
  name: string;
  args?: Record<string, unknown>;
  id?: string;
};

const props = defineProps<{
  message: BaseMessage;
  /** Override which tool calls are shown (e.g. to hide `task` calls). */
  toolCalls?: ToolCallLike[];
}>();

const calls = computed<ToolCallLike[]>(() => {
  if (props.toolCalls) return props.toolCalls;
  return AIMessage.isInstance(props.message)
    ? (props.message.tool_calls ?? [])
    : [];
});

function messageLabel(message: BaseMessage) {
  if (message.type === "human") return "You";
  if (message.type === "tool") return `Tool · ${message.name ?? "result"}`;
  if (message.type === "ai") return "Assistant";
  return message.type;
}

function formatToolArgs(args: Record<string, unknown>) {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  if (entries.length === 1) return String(entries[0]?.[1] ?? "");
  return JSON.stringify(args);
}
</script>

<template>
  <div
    :class="[
      'message',
      { user: message.type === 'human', tool: message.type === 'tool' },
    ]"
  >
    <span>{{ messageLabel(message) }}</span>
    <ul v-if="calls.length > 0" class="tool-call-list">
      <li v-for="(toolCall, toolIndex) in calls" :key="toolCall.id ?? toolIndex">
        <strong>{{ toolCall.name }}</strong>
        <template v-if="formatToolArgs(toolCall.args ?? {})">
          ({{ formatToolArgs(toolCall.args ?? {}) }})
        </template>
      </li>
    </ul>
    <p v-if="message.text">{{ message.text }}</p>
  </div>
</template>
