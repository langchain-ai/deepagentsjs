import type { BaseStore } from "@langchain/langgraph-checkpoint";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";

export interface TodoItem {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface FileTouch {
  path: string;
  operation: "read" | "write" | "edit" | "delete";
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
  files?: FileTouch[];
  controlCommandId?: string;
  controlKind?: ControlCommand["kind"];
  createdBy?: string;
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
  threads: SessionThreadSnapshot[];
  todos?: TodoItem[];
  files?: FileTouch[];
}

export interface SessionThreadSnapshot {
  threadId: string;
  parentThreadId?: string;
  agentKind: "root" | "subagent";
  status: "running" | "idle" | "unknown";
  latestStep?: number;
  latestSummary?: string;
}

export interface SessionEventPage {
  events: ActivityEvent[];
  nextCursor?: string;
}

export interface SessionUpdatePlanEntry {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "skipped";
  priority?: "high" | "medium" | "low";
}

export interface SessionUpdateToolCall {
  id: string;
  name: string;
  kind:
    | "read"
    | "edit"
    | "delete"
    | "move"
    | "search"
    | "execute"
    | "think"
    | "fetch"
    | "other";
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  summary?: string;
  locations?: Array<{ path: string; line?: number }>;
}

export type SessionUpdateKind =
  | "snapshot"
  | "message"
  | "events"
  | "todo_update"
  | "tool_update"
  | "thread_update"
  | "control_update"
  | "status";

export interface SessionUpdate {
  kind: SessionUpdateKind;
  sessionId: string;
  timestamp: string;
  snapshot?: SessionSnapshot;
  events?: ActivityEvent[];
  event?: ActivityEvent;
  plan?: SessionUpdatePlanEntry[];
  tool?: SessionUpdateToolCall;
  thread?: SessionThreadSnapshot;
  status?: SessionSnapshot["session"];
  message?: {
    threadId: string;
    content?: string;
    summary?: string;
    step?: number;
  };
  control?: {
    commandId?: string;
    kind?: ControlCommandKind;
    status: "queued" | "applied" | "rejected";
    createdBy?: string;
  };
  files?: FileTouch[];
}

export interface SessionUpdatePage {
  updates: SessionUpdate[];
  nextCursor?: string;
}

export interface AttachedClientInfo {
  id: string;
  name?: string;
  transport?: string;
  capabilities?: Record<string, unknown>;
}

export interface AttachACPClientOptions {
  client?: AttachedClientInfo;
  allowSteering?: boolean;
  historyLimit?: number;
  pollIntervalMs?: number;
}

export type SessionAttachmentErrorCode =
  | "observe_not_allowed"
  | "steer_not_allowed"
  | "single_client_only"
  | "unsupported_operation";

export class SessionAttachmentError extends Error {
  readonly code: SessionAttachmentErrorCode;
  readonly operation?: string;

  constructor(
    code: SessionAttachmentErrorCode,
    message: string,
    options?: { operation?: string },
  ) {
    super(message);
    this.name = "SessionAttachmentError";
    this.code = code;
    this.operation = options?.operation;
  }
}

export interface ACPAttachedSession {
  client: AttachedClientInfo;
  getInitialUpdates(): Promise<SessionUpdate[]>;
  poll(input?: {
    after?: string;
    limit?: number;
    threadId?: string;
  }): Promise<SessionUpdatePage>;
  subscribe(listener: (update: SessionUpdate) => void): () => void;
  steer(input: SteerAgentInput): Promise<{
    commandId: string;
    status: "queued";
  }>;
  lifecycle(operation: string): Promise<never>;
  close(): void;
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

  poll(input?: {
    after?: string;
    limit?: number;
    threadId?: string;
  }): Promise<SessionUpdatePage>;

  subscribe(
    listener: (update: SessionUpdate) => void,
    input?: {
      after?: string;
      limit?: number;
      threadId?: string;
      pollIntervalMs?: number;
    },
  ): () => void;

  attachACPClient(options?: AttachACPClientOptions): ACPAttachedSession;
}

export interface CreateSessionHandleParams {
  sessionId: string;
  store: BaseStore;
  getState?: (threadId: string) => Promise<any>;
  namespace?: string[];
  pollIntervalMs?: number;
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
