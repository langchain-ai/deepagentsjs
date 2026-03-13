import type {
  ACPAttachedSession,
  AttachACPClientOptions,
  SessionHandle,
  SessionUpdate,
  SessionUpdatePage,
} from "./types.js";
import { SessionAttachmentError } from "./types.js";
import { eventsToSessionUpdates, snapshotToSessionUpdate } from "./updates.js";
import { makeAttachedClient, makeCreatedBy, normalizeSteeringInput } from "./permissions.js";

const DEFAULT_HISTORY_LIMIT = 20;

export async function getInitialSessionUpdates(
  session: SessionHandle,
  historyLimit: number = DEFAULT_HISTORY_LIMIT,
): Promise<SessionUpdate[]> {
  const [snapshot, page] = await Promise.all([
    session.getSnapshot({ scope: "all" }),
    session.getEvents({ limit: historyLimit }),
  ]);

  return [snapshotToSessionUpdate(snapshot), ...eventsToSessionUpdates(page.events)];
}

export function unsupportedLifecycleOperation(operation: string): never {
  throw new SessionAttachmentError(
    "unsupported_operation",
    `Unsupported attached-session lifecycle operation: ${operation}. This surface only supports attaching to an existing live session.`,
    { operation },
  );
}

export function createAttachedACPClientSession(args: {
  session: SessionHandle;
  options?: AttachACPClientOptions;
  onClose: () => void;
}): ACPAttachedSession {
  const { session, options, onClose } = args;
  const client = makeAttachedClient(options?.client);
  const allowSteering = options?.allowSteering ?? false;

  return {
    client,
    async getInitialUpdates() {
      return getInitialSessionUpdates(session, options?.historyLimit);
    },
    async poll(input): Promise<SessionUpdatePage> {
      return session.poll({
        after: input?.after,
        limit: input?.limit ?? options?.historyLimit,
        threadId: input?.threadId,
      });
    },
    subscribe(listener) {
      return session.subscribe(listener, {
        limit: options?.historyLimit,
        pollIntervalMs: options?.pollIntervalMs,
      });
    },
    async steer(input) {
      if (!allowSteering) {
        throw new SessionAttachmentError(
          "steer_not_allowed",
          `Client "${client.id}" is attached in observe-only mode.`,
        );
      }

      const normalized = normalizeSteeringInput(input);
      return session.send({
        kind: normalized.kind,
        target: input.target ?? "active",
        payload: normalized.payload,
        createdBy: makeCreatedBy(client),
      });
    },
    async lifecycle(operation: string) {
      unsupportedLifecycleOperation(operation);
    },
    close() {
      onClose();
    },
  };
}
