<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { HumanMessage } from "@langchain/core/messages";
import { useStreamContext } from "@langchain/vue";

import MessageList from "./MessageList.vue";
import SubagentDetail from "./SubagentDetail.vue";

const EXAMPLE_PROMPT =
  "Research LangGraph streaming, and separately calculate 42 * 17.";

const emit = defineEmits<{ runSettled: [] }>();

const stream = useStreamContext();

// Refresh the sidebar whenever a run finishes (titles derive from the first
// message; order from the latest checkpoint, both owned by the server).
watch(
  () => stream.isLoading.value,
  (loading) => {
    if (!loading) emit("runSettled");
  },
);

const content = ref(EXAMPLE_PROMPT);
const openSubagentId = ref<string | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const subagents = computed(() => [...stream.subagents.value.values()]);
const openSubagent = computed(() =>
  openSubagentId.value
    ? subagents.value.find((snapshot) => snapshot.id === openSubagentId.value)
    : undefined,
);

function autoGrow() {
  const node = textareaRef.value;
  if (!node) return;
  node.style.height = "auto";
  node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
}

function handleSubmit() {
  const nextContent = content.value.trim();
  if (nextContent.length === 0 || stream.isLoading.value) return;

  content.value = "";
  if (textareaRef.value) textareaRef.value.style.height = "auto";
  void stream.submit({ messages: [new HumanMessage(nextContent)] });
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    handleSubmit();
  }
}
</script>

<template>
  <!-- Subagent detail view: breadcrumb + that subagent's chat (no composer). -->
  <main v-if="openSubagent" class="chat-main">
    <nav aria-label="Breadcrumb" class="breadcrumb">
      <button class="crumb-link" type="button" @click="openSubagentId = null">
        Main chat
      </button>
      <span class="crumb-sep">/</span>
      <span class="crumb-current">{{ openSubagent.name }}</span>
    </nav>
    <div class="conversation">
      <div class="conversation-inner">
        <SubagentDetail :snapshot="openSubagent" />
      </div>
    </div>
  </main>

  <!-- Main view: messages + subagent chips, composer pinned at the bottom. -->
  <main v-else class="chat-main">
    <div class="conversation">
      <div class="conversation-inner">
        <MessageList @open-subagent="openSubagentId = $event" />
      </div>
    </div>

    <div class="composer-bar">
      <form class="composer" @submit.prevent="handleSubmit">
        <textarea
          ref="textareaRef"
          v-model="content"
          aria-label="Message"
          placeholder="Ask for research, a calculation, or both..."
          rows="1"
          @input="autoGrow"
          @keydown="handleKeydown"
        />
        <button
          :disabled="content.trim() === '' || stream.isLoading.value"
          type="submit"
        >
          Send
        </button>
      </form>
    </div>
  </main>
</template>
