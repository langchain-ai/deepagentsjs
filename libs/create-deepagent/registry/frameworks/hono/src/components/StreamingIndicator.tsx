import type { BaseMessage } from "@langchain/core/messages";

export function shouldShowTypingIndicator(
  messages: BaseMessage[],
  isLoading: boolean
) {
  if (!isLoading) return false;

  const last = messages.at(-1);
  if (!last) return true;
  if (last.type === "human" || last.type === "tool") return true;
  if (last.type === "ai" && !last.text?.trim()) return true;
  return false;
}

export function TypingDots({ className }: { className?: string }) {
  return (
    <span aria-hidden className={className ?? "typing-dots"}>
      <span />
      <span />
      <span />
    </span>
  );
}

export function StreamingIndicator() {
  return (
    <div
      aria-label="Loading response"
      className="streaming-indicator"
      role="status"
    >
      <TypingDots />
    </div>
  );
}
