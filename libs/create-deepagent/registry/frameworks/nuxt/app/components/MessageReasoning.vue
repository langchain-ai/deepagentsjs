<script setup lang="ts">
import { ref, watch } from "vue";

import TypingDots from "./TypingDots.vue";

const props = defineProps<{ reasoning: string; active: boolean }>();

// Follow the streaming state: expand on start, collapse on finish. A manual
// toggle in between is preserved until `active` flips again.
const open = ref(props.active);
watch(
  () => props.active,
  (value) => {
    open.value = value;
  },
);
</script>

<template>
  <div :class="['reasoning', { open }]">
    <button
      :aria-expanded="open"
      class="reasoning-toggle"
      type="button"
      @click="open = !open"
    >
      <span aria-hidden class="reasoning-caret">▸</span>
      <span aria-hidden class="reasoning-icon">
        <svg
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="1.6"
          viewBox="0 0 24 24"
        >
          <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
          <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
          <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
          <path d="M6 18a4 4 0 0 1-1.967-.516" />
          <path d="M19.967 17.484A4 4 0 0 1 18 18" />
        </svg>
      </span>
      <span class="reasoning-label">Thinking</span>
      <TypingDots v-if="active" variant="inline" class="reasoning-dots" />
    </button>
    <p v-if="open" class="reasoning-text">{{ reasoning }}</p>
  </div>
</template>
