<script lang="ts">
import type { SubagentDiscoverySnapshot } from "@langchain/vue";

export type SubagentStatus = SubagentDiscoverySnapshot["status"];

/** Lightweight model for a subagent card, derived from a `task` tool call. */
export type SubagentCard = {
  /** The `task` tool-call id — also the subagent discovery key. */
  id: string;
  name: string;
  task?: string;
  status: SubagentStatus;
  /** Whether a discovery snapshot exists yet (i.e. the card can be opened). */
  openable: boolean;
};
</script>

<script setup lang="ts">
defineProps<{ cards: SubagentCard[] }>();

const emit = defineEmits<{ open: [id: string] }>();

function statusLabel(status: SubagentStatus) {
  if (status === "running") return "Running";
  if (status === "complete") return "Complete";
  return "Error";
}
</script>

<template>
  <div v-if="cards.length > 0" aria-label="Subagents" class="subagent-list">
    <button
      v-for="card in cards"
      :key="card.id"
      :disabled="!card.openable"
      class="subagent-chip"
      type="button"
      @click="card.openable && emit('open', card.id)"
    >
      <span class="subagent-chip-head">
        <span class="subagent-chip-name">{{ card.name }}</span>
        <span :class="['subagent-status', `status-${card.status}`]">
          {{ statusLabel(card.status) }}
        </span>
      </span>
      <span v-if="card.task" class="subagent-chip-task">{{ card.task }}</span>
    </button>
  </div>
</template>
