<script setup lang="ts">
import TypingDots from "./TypingDots.vue";
</script>

<template>
  <div aria-label="Loading response" class="streaming-indicator" role="status">
    <TypingDots />
  </div>
</template>
