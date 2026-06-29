import { ref } from "vue";

export type Theme = "dark" | "light";

// Module-scoped so the toggle and the chat shell share one source of truth
// across remounts (e.g. when starting a new thread).
const theme = ref<Theme>("dark");

export function useTheme() {
  function toggle() {
    theme.value = theme.value === "dark" ? "light" : "dark";
  }
  return { theme, toggle };
}
