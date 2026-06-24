<script setup lang="ts">
import type { ThreadSummary } from "~/utils/threads";

defineProps<{
  threads: ThreadSummary[];
  activeThreadId: string;
}>();

const emit = defineEmits<{
  select: [threadId: string];
  create: [];
  delete: [threadId: string];
}>();

function formatTime(updatedAt: string | null) {
  if (!updatedAt) return "";
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
</script>

<template>
  <aside aria-label="Thread history" class="sidebar">
    <div class="sidebar-head">
      <span class="eyebrow">History</span>
      <button class="new-thread" type="button" @click="emit('create')">
        + New
      </button>
    </div>

    <ul class="thread-list">
      <li v-if="threads.length === 0" class="thread-empty">
        No conversations yet.
      </li>
      <li
        v-for="thread in threads"
        :key="thread.id"
        :class="['thread-item', { active: thread.id === activeThreadId }]"
      >
        <button
          class="thread-open"
          type="button"
          @click="emit('select', thread.id)"
        >
          <span class="thread-title">{{ thread.title }}</span>
          <span class="thread-time">{{ formatTime(thread.updatedAt) }}</span>
        </button>
        <button
          aria-label="Delete conversation"
          class="thread-delete"
          type="button"
          @click="emit('delete', thread.id)"
        >
          ×
        </button>
      </li>
    </ul>
  </aside>
</template>
