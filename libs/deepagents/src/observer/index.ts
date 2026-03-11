export { createSessionHandle } from "./handle.js";
export { createCompanionAgent } from "./agent.js";
export { createObserveTool, createSteerTool } from "./tool.js";
export type {
  ActivityEvent,
  ActivityEventType,
  ACPAttachedSession,
  AttachACPClientOptions,
  AttachedClientInfo,
  ControlCommand,
  ControlCommandKind,
  ControlCommandTarget,
  ControlCommandPayload,
  FileTouch,
  SessionHandle,
  SessionSnapshot,
  SessionEventPage,
  SessionThreadSnapshot,
  SessionUpdate,
  SessionUpdateKind,
  SessionUpdatePage,
  SessionUpdatePlanEntry,
  SessionUpdateToolCall,
  SessionAttachmentErrorCode,
  CreateSessionHandleParams,
  CreateCompanionAgentParams,
  ObserverMiddlewareOptions,
  CaptureConfig,
  ObserveAgentInput,
  SteerAgentInput,
  TodoItem,
} from "./types.js";
export { SessionAttachmentError } from "./types.js";
