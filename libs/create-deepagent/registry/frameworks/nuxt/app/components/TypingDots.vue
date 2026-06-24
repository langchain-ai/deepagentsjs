<script setup lang="ts">
defineProps<{ variant?: "block" | "inline" }>();
</script>

<template>
  <span aria-hidden :class="variant === 'inline' ? 'inline-dots' : 'typing-dots'">
    <span />
    <span />
    <span />
  </span>
</template>
