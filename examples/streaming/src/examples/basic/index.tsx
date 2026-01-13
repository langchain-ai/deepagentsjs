import { useCallback, useMemo } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import {
  AlertCircle,
  Twitter,
  Sparkles,
  CheckCircle2,
  Zap,
  ClipboardCheck,
  Check,
  Loader2,
} from "lucide-react";
import { useStream } from "@langchain/langgraph-sdk/react";
import type { Message } from "@langchain/langgraph-sdk";

import { registerExample } from "../registry";
import { LoadingIndicator } from "../../components/Loading";
import { EmptyState } from "../../components/States";
import { MessageInput } from "../../components/MessageInput";

import type { agent } from "./agent";

/**
 * Suggestions shown in the empty state
 */
const SUGGESTIONS = [
  "Write a tweet about AI changing the future of work",
  "Create a tweet announcing a new product launch",
  "Tweet about the importance of mental health",
];

/**
 * Known subagent types
 */
const SUBAGENT_ORDER = [
  "correctness-checker",
  "clickbait-enhancer",
  "final-reviewer",
] as const;

type SubagentType = (typeof SUBAGENT_ORDER)[number];

/**
 * Extract text content from a message
 */
function getTextContent(message: Message): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
}

/**
 * Get subagent display info
 */
function getSubagentInfo(name: SubagentType): {
  label: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
  borderColor: string;
} {
  switch (name) {
    case "correctness-checker":
      return {
        label: "Correctness",
        icon: <CheckCircle2 className="w-4 h-4" />,
        color: "text-emerald-400",
        bgColor: "bg-emerald-500/10",
        borderColor: "border-emerald-500/30",
      };
    case "clickbait-enhancer":
      return {
        label: "Engagement",
        icon: <Zap className="w-4 h-4" />,
        color: "text-amber-400",
        bgColor: "bg-amber-500/10",
        borderColor: "border-amber-500/30",
      };
    case "final-reviewer":
      return {
        label: "Review",
        icon: <ClipboardCheck className="w-4 h-4" />,
        color: "text-purple-400",
        bgColor: "bg-purple-500/10",
        borderColor: "border-purple-500/30",
      };
  }
}

/**
 * Extract the best tweet from the final AI message
 */
function extractFinalTweet(content: string): string | null {
  // Look for tweet in quotes with emoji indicators
  const emojiQuoteMatch = content.match(/"(🌟[^"]{20,350})"/);
  if (emojiQuoteMatch) return emojiQuoteMatch[1];

  // Look for "Suggested Revision" or similar
  const revisionMatch = content.match(
    /\*\*Suggested Revision\*\*:\s*"([^"]{20,350})"/i
  );
  if (revisionMatch) return revisionMatch[1];

  // Generic quote extraction for tweet-like content
  const quoteMatch = content.match(/"([^"]{50,350})"/);
  if (quoteMatch) return quoteMatch[1];

  return null;
}

/**
 * Check if content is a meaningful subagent result (not just "Please provide...")
 */
function isMeaningfulResult(content: string): boolean {
  const lowered = content.toLowerCase();
  // Filter out "please provide" type messages
  if (
    lowered.includes("please provide") ||
    lowered.includes("please share") ||
    lowered.includes("please send") ||
    lowered.includes("please paste")
  ) {
    return false;
  }
  // Filter out very short responses
  if (content.trim().length < 30) {
    return false;
  }
  return true;
}

/**
 * Summarize a subagent result to a short snippet
 */
function summarizeResult(content: string): string {
  const lowered = content.toLowerCase();

  // Check for positive final outcomes first (these take priority)
  if (content.includes("READY TO POST ✅")) return "✓ Ready to post";
  if (
    lowered.includes("ready to post") ||
    lowered.includes("polished and ready") ||
    lowered.includes("good to go")
  ) {
    return "✓ Ready to post";
  }

  // Check for approval
  if (content.includes("APPROVED")) return "✓ Approved - No issues found";

  // Check for revision with a provided fix (this is still a success)
  if (
    content.includes("NEEDS REVISION") &&
    (lowered.includes("suggested revision") ||
      lowered.includes("here's the") ||
      lowered.includes("revised tweet"))
  ) {
    return "✓ Revised and improved";
  }

  // Pure revision request without fix
  if (content.includes("NEEDS REVISION")) return "⚠ Revision suggested";

  // Look for enhancement indicators
  if (
    lowered.includes("enhanced") ||
    lowered.includes("improved") ||
    lowered.includes("boosted")
  ) {
    return "✓ Enhanced for engagement";
  }

  // Truncate to first meaningful sentence
  const firstSentence = content.split(/[.!?]/)[0];
  if (firstSentence && firstSentence.length > 10) {
    return firstSentence.length > 80
      ? firstSentence.substring(0, 77) + "..."
      : firstSentence;
  }

  return content.length > 80 ? content.substring(0, 77) + "..." : content;
}

// ============================================================================
// Subagent Step - Used in the pipeline
// ============================================================================

interface SubagentStep {
  type: SubagentType;
  status: "pending" | "running" | "complete";
  result?: string;
}

// ============================================================================
// Pipeline Progress Component
// ============================================================================

function PipelineProgress({
  steps,
  isLoading,
}: {
  steps: SubagentStep[];
  isLoading: boolean;
}) {
  return (
    <div className="bg-neutral-900/50 rounded-xl border border-neutral-800 p-4 animate-fade-in">
      <div className="flex items-center gap-2 mb-4">
        <Sparkles className="w-4 h-4 text-sky-400" />
        <span className="text-sm font-medium text-neutral-300">
          Tweet Pipeline
        </span>
        {isLoading && (
          <Loader2 className="w-3 h-3 text-neutral-500 animate-spin ml-auto" />
        )}
      </div>

      <div className="space-y-3">
        {steps.map((step, idx) => {
          const info = getSubagentInfo(step.type);
          const isLast = idx === steps.length - 1;

          return (
            <div key={step.type} className="relative">
              {/* Connection line */}
              {!isLast && (
                <div
                  className={`absolute left-[11px] top-[28px] w-0.5 h-[calc(100%+4px)] ${
                    step.status === "complete"
                      ? "bg-neutral-700"
                      : "bg-neutral-800"
                  }`}
                />
              )}

              <div className="flex items-start gap-3">
                {/* Status indicator - solid bg-neutral-950 base to cover the line */}
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 bg-neutral-950 ${
                    step.status === "complete"
                      ? `${info.borderColor} border-2`
                      : step.status === "running"
                      ? `${info.borderColor} border-2 animate-pulse`
                      : "border-2 border-neutral-700"
                  }`}
                >
                  {step.status === "complete" ? (
                    <Check className={`w-3 h-3 ${info.color}`} />
                  ) : step.status === "running" ? (
                    <Loader2 className={`w-3 h-3 ${info.color} animate-spin`} />
                  ) : (
                    <span className="w-2 h-2 rounded-full bg-neutral-600" />
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0 pb-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-sm font-medium ${
                        step.status === "pending"
                          ? "text-neutral-500"
                          : info.color
                      }`}
                    >
                      {info.label}
                    </span>
                  </div>

                  {step.result && (
                    <p className="text-xs text-neutral-400 mt-1">
                      {summarizeResult(step.result)}
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Tweet Card Component
// ============================================================================

function TweetCard({ content }: { content: string }) {
  const charCount = content.length;
  const isOverLimit = charCount > 280;

  return (
    <div className="bg-neutral-900 rounded-xl border border-neutral-800 overflow-hidden animate-fade-in">
      {/* Header */}
      <div className="px-4 py-3 border-b border-neutral-800 flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-sky-500 flex items-center justify-center">
          <Twitter className="w-5 h-5 text-white" />
        </div>
        <div>
          <div className="font-semibold text-white text-sm">Your Tweet</div>
          <div className="text-xs text-neutral-500">@username</div>
        </div>
      </div>

      {/* Tweet content */}
      <div className="px-4 py-4">
        <p className="text-white text-[15px] leading-relaxed whitespace-pre-wrap">
          {content}
        </p>
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-neutral-800 flex items-center justify-between">
        <div className="flex items-center gap-4 text-neutral-500 text-sm">
          <span>💬 Reply</span>
          <span>🔄 Retweet</span>
          <span>❤️ Like</span>
        </div>
        <div
          className={`text-xs font-mono ${
            isOverLimit ? "text-red-400" : "text-neutral-500"
          }`}
        >
          {charCount}/280
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * Tweet Generator Example
 *
 * Demonstrates how to use `useStream` with a `createDeepAgent` that uses
 * subagents to create and refine tweets through multiple review stages.
 */
export function TweetGenerator() {
  const stream = useStream<typeof agent>({
    assistantId: "basic-agent",
    apiUrl: "http://localhost:2024",
  });

  const { scrollRef, contentRef } = useStickToBottom();
  const hasMessages = stream.messages.length > 0;

  const handleSubmit = useCallback(
    (content: string) => {
      stream.submit(
        { messages: [{ content, type: "human" }] },
        {
          config: {
            recursion_limit: 100,
          },
        }
      );
    },
    [stream]
  );

  // Process messages to extract pipeline state and final tweet
  const { userMessage, pipelineSteps, finalTweet, finalMessage } =
    useMemo(() => {
      let userMsg: string | null = null;
      const completedSubagents = new Set<SubagentType>();
      const subagentResults = new Map<SubagentType, string>();
      let runningSubagent: SubagentType | null = null;
      let finalTweetText: string | null = null;
      let finalMsg: string | null = null;

      for (let i = 0; i < stream.messages.length; i++) {
        const msg = stream.messages[i];
        const content = getTextContent(msg);

        // Extract user message
        if (msg.type === "human" && !userMsg) {
          userMsg = content;
          continue;
        }

        // Check for subagent invocations in AI messages
        if (msg.type === "ai") {
          const toolCalls = (msg as any).tool_calls;
          if (Array.isArray(toolCalls)) {
            for (const tc of toolCalls) {
              if (tc.name === "task" && tc.args?.subagent_type) {
                const subType = tc.args.subagent_type as SubagentType;
                if (SUBAGENT_ORDER.includes(subType)) {
                  runningSubagent = subType;
                }
              }
            }
          }

          // Check for final message (after all subagents)
          if (
            content &&
            content.length > 100 &&
            completedSubagents.size === 3
          ) {
            finalMsg = content;
            finalTweetText = extractFinalTweet(content);
          }
        }

        // Check for subagent results in tool messages
        if (msg.type === "tool" && (msg as any).name === "task") {
          if (isMeaningfulResult(content)) {
            // Find which subagent this result is for
            const toolCallId = (msg as any).tool_call_id;
            for (let j = i - 1; j >= 0; j--) {
              const prevMsg = stream.messages[j];
              if (prevMsg.type === "ai") {
                const toolCalls = (prevMsg as any).tool_calls;
                if (Array.isArray(toolCalls)) {
                  const matchingCall = toolCalls.find(
                    (tc: any) => tc.id === toolCallId && tc.name === "task"
                  );
                  if (matchingCall?.args?.subagent_type) {
                    const subType = matchingCall.args
                      .subagent_type as SubagentType;
                    if (SUBAGENT_ORDER.includes(subType)) {
                      completedSubagents.add(subType);
                      subagentResults.set(subType, content);
                      if (runningSubagent === subType) {
                        runningSubagent = null;
                      }
                    }
                    break;
                  }
                }
              }
            }
          }
        }
      }

      // Build pipeline steps
      const steps: SubagentStep[] = SUBAGENT_ORDER.map((type) => ({
        type,
        status: completedSubagents.has(type)
          ? "complete"
          : runningSubagent === type
          ? "running"
          : "pending",
        result: subagentResults.get(type),
      }));

      return {
        userMessage: userMsg,
        pipelineSteps: steps,
        finalTweet: finalTweetText,
        finalMessage: finalMsg,
      };
    }, [stream.messages]);

  // Check if we've started processing (any subagent activity)
  const hasStarted =
    pipelineSteps.some((s) => s.status !== "pending") || stream.isLoading;
  const isComplete = pipelineSteps.every((s) => s.status === "complete");

  return (
    <div className="h-full flex flex-col">
      <main ref={scrollRef} className="flex-1 overflow-y-auto">
        <div ref={contentRef} className="max-w-2xl mx-auto px-4 py-8">
          {!hasMessages ? (
            <EmptyState
              icon={Twitter}
              title="Tweet Generator"
              description="Create viral-worthy tweets using AI! Your tweet goes through multiple review stages: correctness checking, engagement optimization, and final polish."
              suggestions={SUGGESTIONS}
              onSuggestionClick={handleSubmit}
            />
          ) : (
            <div className="flex flex-col gap-6">
              {/* User's request */}
              {userMessage && (
                <div className="animate-fade-in">
                  <div className="flex justify-end">
                    <div className="bg-sky-600 text-white rounded-2xl px-4 py-2.5 max-w-[85%] md:max-w-[70%]">
                      <div className="whitespace-pre-wrap leading-relaxed text-[15px]">
                        {userMessage}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Pipeline progress */}
              {hasStarted && (
                <PipelineProgress
                  steps={pipelineSteps}
                  isLoading={stream.isLoading && !isComplete}
                />
              )}

              {/* Final tweet */}
              {finalTweet && isComplete && <TweetCard content={finalTweet} />}

              {/* Final message from agent */}
              {finalMessage && isComplete && (
                <div className="animate-fade-in">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-6 h-6 rounded-full bg-sky-500/20 border border-sky-500/30 flex items-center justify-center">
                      <Sparkles className="w-3 h-3 text-sky-400" />
                    </div>
                    <span className="text-xs font-medium text-neutral-500">
                      Tweet Generator
                    </span>
                  </div>
                  <div className="text-neutral-100 ml-8">
                    <div className="whitespace-pre-wrap leading-relaxed text-[15px]">
                      {finalMessage}
                    </div>
                  </div>
                </div>
              )}

              {/* Loading indicator for initial state */}
              {stream.isLoading && !hasStarted && <LoadingIndicator />}
            </div>
          )}
        </div>
      </main>

      {/* Error display */}
      {stream.error != null && (
        <div className="max-w-2xl mx-auto px-4 pb-3">
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-red-400 text-sm">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>
                {stream.error &&
                typeof stream.error === "object" &&
                "message" in stream.error
                  ? (stream.error as Error).message
                  : "An error occurred"}
              </span>
            </div>
          </div>
        </div>
      )}

      <MessageInput
        disabled={stream.isLoading}
        placeholder="What should we tweet about?"
        onSubmit={handleSubmit}
      />
    </div>
  );
}

// Register this example
registerExample({
  id: "basic-agent",
  title: "Tweet Generator",
  description:
    "Create viral tweets with AI-powered subagents for correctness, engagement, and review",
  category: "agents",
  icon: "chat",
  ready: true,
  component: TweetGenerator,
});

export default TweetGenerator;
