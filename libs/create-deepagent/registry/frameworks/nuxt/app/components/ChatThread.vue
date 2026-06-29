<script setup lang="ts">
import { HttpAgentServerAdapter, provideStream } from "@langchain/vue";

import { getApiUrl } from "~/utils/threads";
import Chat from "./Chat.vue";

const props = defineProps<{ threadId: string }>();
const emit = defineEmits<{ runSettled: [] }>();

// The component is keyed by `threadId` in the parent, so the transport is built
// once per thread. Provide the stream so every descendant reads it via
// `useStreamContext()`.
const transport = new HttpAgentServerAdapter({
  apiUrl: getApiUrl(),
  threadId: props.threadId,
  paths: {
    commands: `/threads/${props.threadId}/commands`,
    stream: `/threads/${props.threadId}/stream`,
  },
});

provideStream({ transport, threadId: props.threadId });
</script>

<template>
  <Chat @run-settled="emit('runSettled')" />
</template>
