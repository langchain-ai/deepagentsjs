"use client";

import { useState } from "react";

export type ToolCallStatus = "running" | "complete" | "error";

export type ToolCallView = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  output?: string;
  status: ToolCallStatus;
};

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

function ToolIcon() {
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
      <path d="M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 1 5.4-5.4l-2.7 2.7-1.4-1.4 2.7-2.7a4 4 0 0 0-1.6.4z" />
    </svg>
  );
}

/**
 * A subtle, collapsible representation of a single tool call: an icon, the
 * tool name, and its status. Expanding reveals the stringified input (args)
 * and output (the tool result).
 */
export function ToolCall({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`toolcall status-${call.status}`}>
      <button
        aria-expanded={open}
        className="toolcall-head"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="toolcall-icon">
          <ToolIcon />
        </span>
        <span className="toolcall-name">{call.name}</span>
        <span className={`subagent-status status-${call.status}`}>
          {statusLabel(call.status)}
        </span>
        <span aria-hidden className="toolcall-chevron">
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open ? (
        <div className="toolcall-body">
          <div className="toolcall-section">
            <span>Input</span>
            <pre>{stringifyArgs(call.args)}</pre>
          </div>
          {call.output != null && call.output !== "" ? (
            <div className="toolcall-section">
              <span>Output</span>
              <pre>{call.output}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
