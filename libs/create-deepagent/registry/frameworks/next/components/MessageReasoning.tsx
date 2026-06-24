"use client";

import { useEffect, useState } from "react";

import { TypingDots } from "./StreamingIndicator";

function BrainIcon() {
  return (
    <svg
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
    >
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
      <path d="M6 18a4 4 0 0 1-1.967-.516" />
      <path d="M19.967 17.484A4 4 0 0 1 18 18" />
    </svg>
  );
}

/**
 * Minimalistic reasoning block: a `Thinking` toggle with a brain icon and a
 * caret, rendered inline in the conversation (not inside a message bubble).
 *
 * While reasoning tokens stream (`active`), the block auto-expands so you can
 * watch the model think; once the turn finishes it auto-collapses. The caret
 * stays clickable so a finished block can be re-opened.
 */
export function MessageReasoning({
  reasoning,
  active,
}: {
  reasoning: string;
  active: boolean;
}) {
  const [open, setOpen] = useState(active);

  // Follow the streaming state: expand on start, collapse on finish. The effect
  // only runs when `active` flips, so a manual toggle in between is preserved.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(active);
  }, [active]);

  return (
    <div className={`reasoning ${open ? "open" : ""}`}>
      <button
        aria-expanded={open}
        className="reasoning-toggle"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span aria-hidden className="reasoning-caret">
          ▸
        </span>
        <span aria-hidden className="reasoning-icon">
          <BrainIcon />
        </span>
        <span className="reasoning-label">Thinking</span>
        {active ? <TypingDots className="inline-dots reasoning-dots" /> : null}
      </button>
      {open ? <p className="reasoning-text">{reasoning}</p> : null}
    </div>
  );
}
