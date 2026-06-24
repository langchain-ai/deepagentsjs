<script setup lang="ts">
import { computed, toRef } from "vue";
import type { BaseMessage } from "@langchain/core/messages";
import { useMessages, useStreamContext, type SubagentDiscoverySnapshot } from "@langchain/vue";

import MessageBubbles from "./MessageBubbles.vue";
import StreamingIndicator from "./StreamingIndicator.vue";

const props = defineProps<{ snapshot: SubagentDiscoverySnapshot }>();

const stream = useStreamContext();

// `useMessages` is scoped to the subagent's namespace, so its tokens, tool
// calls, and results stream independently from the root conversation.
const messages = useMessages(stream, toRef(props, "snapshot"));

function omitTaskHumanMessage(
  thread: BaseMessage[],
  taskInput?: string
): BaseMessage[] {
  const task = taskInput?.trim();
  if (!task) return thread;
  return thread.filter(
    (message) => message.type !== "human" || message.text?.trim() !== task
  );
}

const visibleMessages = computed(() =>
  omitTaskHumanMessage(messages.value, props.snapshot.taskInput)
);
</script>

<template>
  <div v-if="snapshot.taskInput" class="subagent-prompt">
    <span>Task</span>
    <p>{{ snapshot.taskInput }}</p>
  </div>

  <MessageBubbles
    :is-loading="snapshot.status === 'running'"
    :messages="visibleMessages"
  />

  <StreamingIndicator
    v-if="snapshot.status === 'running' && visibleMessages.length === 0"
  />
</template>
