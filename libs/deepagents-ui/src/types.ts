import type {
  ACPAttachedSession,
  AttachACPClientOptions,
  AttachedClientInfo,
  SessionHandle,
} from "deepagents";

export type MiddlemanPermission = "observe" | "steer";

export interface MiddlemanPermissionPolicy {
  defaultAccess?: "observe" | "none";
  canObserve?: (client: AttachedClientInfo) => boolean | Promise<boolean>;
  canSteer?: (client: AttachedClientInfo) => boolean | Promise<boolean>;
}

export interface MiddlemanAttachOptions
  extends Omit<AttachACPClientOptions, "client"> {
  client?: Partial<AttachedClientInfo>;
}

export interface WebUIRuntimeOptions {
  port?: number;
  host?: string;
  open?: boolean;
  client?: Partial<AttachedClientInfo>;
  historyLimit?: number;
  pollIntervalMs?: number;
  allowSteering?: boolean;
}

export interface WebUIRuntime {
  url?: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface MiddlemanOptions {
  session: SessionHandle;
  permissions?: MiddlemanPermissionPolicy;
  allowSteering?: boolean;
}

export interface MiddlemanRuntime {
  session: SessionHandle;
  attachACPClient(options?: MiddlemanAttachOptions): ACPAttachedSession;
  createWebUI(options?: WebUIRuntimeOptions): WebUIRuntime;
}
