<script lang="ts">
export type ToolCallStatus = "running" | "complete" | "error";

export type ToolCallView = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  output?: string;
  status: ToolCallStatus;
};
</script>

<script setup lang="ts">
import { ref } from "vue";

defineProps<{ call: ToolCallView }>();

const open = ref(false);

function stringifyArgs(args: Record<string, unknown>) {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function statusLabel(status: ToolCallStatus) {
  if (status === "running") return "Running";
  if (status === "error") return "Error";
  return "Done";
}
</script>

<template>
  <div :class="['toolcall', `status-${call.status}`]">
    <button
      :aria-expanded="open"
      class="toolcall-head"
      type="button"
      @click="open = !open"
    >
      <span class="toolcall-icon">
        <svg
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="1.6"
          viewBox="0 0 24 24"
        >
          <path d="M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 1 5.4-5.4l-2.7 2.7-1.4-1.4 2.7-2.7a4 4 0 0 0-1.6.4z" />
        </svg>
      </span>
      <span class="toolcall-name">{{ call.name }}</span>
      <span :class="['subagent-status', `status-${call.status}`]">
        {{ statusLabel(call.status) }}
      </span>
      <span aria-hidden="true" class="toolcall-chevron">{{ open ? "▾" : "▸" }}</span>
    </button>

    <div v-if="open" class="toolcall-body">
      <div class="toolcall-section">
        <span>Input</span>
        <pre>{{ stringifyArgs(call.args) }}</pre>
      </div>
      <div
        v-if="call.output != null && call.output !== ''"
        class="toolcall-section"
      >
        <span>Output</span>
        <pre>{{ call.output }}</pre>
      </div>
    </div>
  </div>
</template>
