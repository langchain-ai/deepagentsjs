import { useState, type ReactNode } from "react";
import { Loader2, CheckCircle2, AlertCircle, Clock, ArrowDownToLine, Copy, Check } from "lucide-react";
import type { AsyncTask } from "../types";

export interface ResearcherConfig {
  label: string;
  icon: ReactNode;
  gradient: string;
  borderColor: string;
  bgColor: string;
  iconBg: string;
  accentColor: string;
}

function StatusIcon({ status, accentColor }: { status: string; accentColor: string }) {
  switch (status) {
    case "running":
      return <Loader2 className={`w-4 h-4 animate-spin ${accentColor}`} />;
    case "success":
      return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
    case "error":
    case "interrupted":
    case "timeout":
    case "cancelled":
      return <AlertCircle className="w-4 h-4 text-red-400" />;
    default:
      return <Clock className="w-4 h-4 text-neutral-500" />;
  }
}

export function ResearcherCard({
  config,
  task,
  onGetResults,
}: {
  config: ResearcherConfig;
  task: AsyncTask;
  onGetResults: (task: AsyncTask) => void;
}) {
  const status = task.status;
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(task.taskId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className={`
        relative w-80 rounded-2xl border-2 transition-all duration-300
        ${
          status === "running"
            ? `${config.borderColor} ${config.bgColor}`
            : status === "success"
              ? "border-emerald-500/40 bg-emerald-950/20"
              : status === "error" || status === "timeout" || status === "interrupted" || status === "cancelled"
                ? "border-red-500/40 bg-red-950/20"
                : "border-neutral-800 bg-neutral-900/40"
        }
      `}
    >
      {/* Header */}
      <div
        className={`flex items-center gap-3 px-4 py-3 border-b border-neutral-800/50 rounded-t-xl bg-linear-to-r ${config.gradient}`}
      >
        <div
          className={`w-9 h-9 rounded-xl flex items-center justify-center ${config.iconBg} ${config.accentColor}`}
        >
          {config.icon}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className={`text-sm font-semibold ${config.accentColor}`}>
            {config.label}
          </h3>
        </div>
        <StatusIcon status={status} accentColor={config.accentColor} />
      </div>

      {/* Body */}
      <div className="px-4 py-3 flex flex-col gap-2">
        {/* Task description */}
        {task.description && (
          <p className="text-xs text-neutral-400 leading-relaxed line-clamp-3">
            {task.description}
          </p>
        )}

        {/* Task ID + actions */}
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={handleCopy}
            title={task.taskId}
            className="flex items-center gap-1.5 text-xs text-neutral-600 font-mono hover:text-neutral-400 transition-colors cursor-pointer min-w-0"
          >
            {copied ? (
              <Check className="w-3 h-3 text-emerald-400 shrink-0" />
            ) : (
              <Copy className="w-3 h-3 shrink-0" />
            )}
            <span className="truncate">{task.taskId}</span>
          </button>
          {status === "success" && (
            <button
              onClick={() => onGetResults(task)}
              className={`flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg ${config.accentColor} ${config.iconBg} hover:opacity-80 transition-opacity cursor-pointer shrink-0`}
            >
              <ArrowDownToLine className="w-3 h-3" />
              Results
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
