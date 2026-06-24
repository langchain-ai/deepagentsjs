<script setup lang="ts">
import { onMounted, ref } from "vue";

import { useTheme } from "~/composables/useTheme";
import {
  type ThreadSummary,
  createThread,
  deleteThread,
  fetchThreads,
} from "~/utils/threads";
import ChatThread from "./ChatThread.vue";
import ThemeToggle from "./ThemeToggle.vue";
import ThreadHistory from "./ThreadHistory.vue";

const { theme } = useTheme();

const mounted = ref(false);
const threads = ref<ThreadSummary[]>([]);
const threadId = ref("");

async function refreshThreads() {
  threads.value = await fetchThreads();
}

// On mount, load threads from the server (single source of truth). If none
// exist yet, create one.
onMounted(async () => {
  const list = await fetchThreads();
  if (list.length > 0) {
    threads.value = list;
    threadId.value = list[0]!.id;
  } else {
    const id = await createThread();
    threads.value = await fetchThreads();
    threadId.value = id;
  }
  mounted.value = true;
});

function handleSelect(id: string) {
  if (id !== threadId.value) threadId.value = id;
}

async function handleCreate() {
  const id = await createThread();
  await refreshThreads();
  threadId.value = id;
}

async function handleDelete(id: string) {
  await deleteThread(id);
  const list = await fetchThreads();
  threads.value = list;
  if (id !== threadId.value) return;
  if (list.length > 0) {
    threadId.value = list[0]!.id;
  } else {
    const freshId = await createThread();
    threads.value = await fetchThreads();
    threadId.value = freshId;
  }
}
</script>

<template>
  <div :class="['app-shell', { light: theme === 'light' }]">
    <template v-if="!mounted || !threadId">
      <div class="empty-state center">Preparing chat…</div>
    </template>

    <template v-else>
      <ThemeToggle />

      <ThreadHistory
        :active-thread-id="threadId"
        :threads="threads"
        @create="handleCreate"
        @delete="handleDelete"
        @select="handleSelect"
      />

      <ChatThread
        :key="threadId"
        :thread-id="threadId"
        @run-settled="refreshThreads"
      />
    </template>
  </div>
</template>
