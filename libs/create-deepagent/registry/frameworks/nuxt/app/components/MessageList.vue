<script setup lang="ts">
import { computed } from "vue";
import type { BaseMessage } from "@langchain/core/messages";
import { useStreamContext } from "@langchain/vue";

import { shouldShowTypingIndicator } from "~/utils/streaming";
import MessageBubbles from "./MessageBubbles.vue";
import StreamingIndicator from "./StreamingIndicator.vue";

const emit = defineEmits<{ openSubagent: [id: string] }>();

const stream = useStreamContext();

const messages = computed(() =>
  stream.messages.value.filter((message): message is BaseMessage => message != null),
);

const subagents = computed(() => [...stream.subagents.value.values()]);

const showTypingIndicator = computed(() =>
  shouldShowTypingIndicator(messages.value, stream.isLoading.value),
);
</script>

<template>
  <div v-if="messages.length === 0 && !stream.error.value" class="empty-state">
    Ask a question below. The coordinator will delegate to its subagents and
    stream tokens, tool calls, and results.
  </div>

  <MessageBubbles
    :is-loading="stream.isLoading.value"
    :messages="messages"
    :subagents="subagents"
    @open-subagent="emit('openSubagent', $event)"
  />

  <StreamingIndicator v-if="showTypingIndicator" />

  <div
    v-if="messages.length === 0 && !stream.isLoading.value && stream.error.value"
    class="error"
  >
    Could not reach the agent API. Make sure the dev server is running and
    <code>OPENAI_API_KEY</code> is set, then try again.
  </div>
</template>
