import type { BaseStore } from "@langchain/langgraph-checkpoint";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";

export interface TodoItem {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export type ActivityEventType =
  | "model_response"
  | "tool_result"
  | "todo_snapshot"
  | "files_touched"
  | "control_queued"
  | "control_applied"
  | "control_rejected"
  | "thread_started"
  | "thread_completed"
  | "thread_failed";

export interface ActivityEvent {
  id: string;
  sessionId: string;
  threadId: string;
  parentThreadId?: string;
  agentKind?: "root" | "subagent";
  type: ActivityEventType;
  timestamp: string;
  step?: number;
  summary?: string;
  content?: string;
  toolCalls?: Array<{
    name: string;
    args: string;
  }>;
  toolName?: string;
  success?: boolean;
  todos?: TodoItem[];
  files?: Array<{
    path: string;
    operation: "read" | "write" | "edit" | "delete";
  }>;
  controlCommandId?: string;
  controlKind?: ControlCommand["kind"];
}

export type ControlCommandKind =
  | "message"
  | "reminder"
  | "add_todo"
  | "update_todo"
  | "set_guidance";

export type ControlCommandTarget =
  | "root"
  | "active"
  | "all"
  | { threadId: string };

export type ControlCommandPayload =
  | { text: string }
  | { content: string }
  | {
      id?: string;
      content: string;
      status?: "pending" | "in_progress" | "completed";
    }
  | { id: string; status: "pending" | "in_progress" | "completed" }
  | { text: string; scope?: "session" | "thread" };

export interface ControlCommand {
  id: string;
  sessionId: string;
  target: ControlCommandTarget;
  status: "queued" | "applied" | "rejected";
  createdAt: string;
  createdBy?: string;
  kind: ControlCommandKind;
  payload: ControlCommandPayload;
}

export interface SessionSnapshot {
  session: {
    sessionId: string;
    running: boolean | "unknown";
    activeThreadId?: string;
    updatedAt?: string;
  };
  threads: Array<{
    threadId: string;
    parentThreadId?: string;
    agentKind: "root" | "subagent";
    status: "running" | "idle" | "unknown";
    latestStep?: number;
    latestSummary?: string;
  }>;
  todos?: TodoItem[];
  files?: Array<{
    path: string;
    operation: "read" | "write" | "edit" | "delete";
  }>;
}

export interface SessionEventPage {
  events: ActivityEvent[];
  nextCursor?: string;
}

export interface SessionHandle {
  getSnapshot(input?: {
    scope?: "active" | "root" | "all";
  }): Promise<SessionSnapshot>;

  getEvents(input?: {
    after?: string;
    limit?: number;
    threadId?: string;
  }): Promise<SessionEventPage>;

  send(
    input: Omit<ControlCommand, "id" | "sessionId" | "status" | "createdAt">,
  ): Promise<{
    commandId: string;
    status: "queued";
  }>;
}

export interface CreateSessionHandleParams {
  sessionId: string;
  store: BaseStore;
  getState?: (threadId: string) => Promise<any>;
  namespace?: string[];
}

export interface CreateCompanionAgentParams {
  session: SessionHandle;
  model?: string | BaseLanguageModel;
  systemPrompt?: string;
  checkpointer?: BaseCheckpointSaver;
  allowSteering?: boolean;
}

export interface CaptureConfig {
  modelResponses?: boolean;
  toolResults?: boolean;
  todos?: boolean;
  files?: boolean;
  lifecycle?: boolean;
  control?: boolean;
}

export interface ObserverMiddlewareOptions {
  namespace?: string[];
  sessionId?: string;
  capture?: CaptureConfig;
  maxEvents?: number;
  enableControl?: boolean;
  store?: BaseStore;
}

export interface ObserveAgentInput {
  focus?: string;
  scope?: "active" | "root" | "all";
  after?: string;
  limit?: number;
  threadId?: string;
}

export interface SteerAgentInput {
  kind: ControlCommandKind;
  target?: ControlCommandTarget;
  payload: ControlCommandPayload;
}
