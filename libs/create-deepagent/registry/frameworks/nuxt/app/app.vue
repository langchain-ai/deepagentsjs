<script setup lang="ts">
import ChatApp from "./components/ChatApp.vue";

useHead({
  title: "Nuxt Deep Agent",
  meta: [
    {
      name: "description",
      content:
        "Deploy a LangChain deep agent with Nuxt: thread storage, history, " +
        "and a subagent-aware chat UI powered by @langchain/vue.",
    },
  ],
});
</script>

<template>
  <ClientOnly>
    <ChatApp />
    <template #fallback>
      <div class="app-shell">
        <div class="empty-state center">Loading…</div>
      </div>
    </template>
  </ClientOnly>
</template>
