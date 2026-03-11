import type { BaseStore } from "@langchain/langgraph-checkpoint";
import type { ActivityEvent, ControlCommand } from "./types.js";

export const INDEX_KEY = "_index";
export const DEFAULT_NAMESPACE = ["observer"];
export const DEFAULT_MAX_EVENTS = 100;

export function getEventsNamespace(
  baseNamespace: string[],
  sessionId: string,
): string[] {
  return [...baseNamespace, sessionId, "events"];
}

export function getControlNamespace(
  baseNamespace: string[],
  sessionId: string,
): string[] {
  return [...baseNamespace, sessionId, "control"];
}

export function getThreadNamespace(
  baseNamespace: string[],
  sessionId: string,
  threadId: string,
): string[] {
  return [...baseNamespace, sessionId, "threads", threadId];
}

export function makeEventKey(sequence: number): string {
  return `event-${String(sequence).padStart(8, "0")}`;
}

export function makeControlKey(sequence: number): string {
  return `cmd-${String(sequence).padStart(8, "0")}`;
}

export async function readIndex(
  store: BaseStore,
  namespace: string[],
  sessionId: string,
): Promise<string[]> {
  const ns = getEventsNamespace(namespace, sessionId);
  const item = await store.get(ns, INDEX_KEY);
  if (!item) return [];
  return (item.value as { keys: string[] }).keys ?? [];
}

async function writeIndex(
  store: BaseStore,
  namespace: string[],
  sessionId: string,
  keys: string[],
): Promise<void> {
  const ns = getEventsNamespace(namespace, sessionId);
  await store.put(ns, INDEX_KEY, { keys });
}

export async function writeActivityEvent(
  store: BaseStore,
  namespace: string[],
  sessionId: string,
  event: ActivityEvent,
  maxEvents: number = DEFAULT_MAX_EVENTS,
): Promise<void> {
  const ns = getEventsNamespace(namespace, sessionId);
  const keys = await readIndex(store, namespace, sessionId);

  const sequence = keys.length > 0 ? parseSequence(keys[keys.length - 1]) + 1 : 0;
  const key = makeEventKey(sequence);

  await store.put(ns, key, event as unknown as Record<string, any>);

  const updatedKeys = [...keys, key];

  if (updatedKeys.length > maxEvents) {
    const toRemove = updatedKeys.splice(0, updatedKeys.length - maxEvents);
    for (const oldKey of toRemove) {
      await store.delete(ns, oldKey);
    }
  }

  await writeIndex(store, namespace, sessionId, updatedKeys);
}

function parseSequence(key: string): number {
  const match = key.match(/(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
}

export async function readActivityEvents(
  store: BaseStore,
  namespace: string[],
  sessionId: string,
  options: { after?: string; limit?: number; threadId?: string } = {},
): Promise<{ events: ActivityEvent[]; nextCursor?: string }> {
  const { after, limit = 20, threadId } = options;
  const keys = await readIndex(store, namespace, sessionId);
  const ns = getEventsNamespace(namespace, sessionId);

  let startIdx = 0;
  if (after) {
    const afterIdx = keys.indexOf(after);
    if (afterIdx >= 0) {
      startIdx = afterIdx + 1;
    }
  }

  const candidateKeys = keys.slice(startIdx);
  const events: ActivityEvent[] = [];
  let lastKey: string | undefined;

  for (const key of candidateKeys) {
    if (events.length >= limit) break;
    const item = await store.get(ns, key);
    if (!item) continue;
    const event = item.value as unknown as ActivityEvent;
    if (threadId && event.threadId !== threadId) continue;
    events.push(event);
    lastKey = key;
  }

  const nextCursor =
    lastKey && keys.indexOf(lastKey) < keys.length - 1 ? lastKey : undefined;

  return { events, nextCursor };
}

export async function writeControlCommand(
  store: BaseStore,
  namespace: string[],
  sessionId: string,
  command: ControlCommand,
): Promise<void> {
  const ns = getControlNamespace(namespace, sessionId);
  const items = await store.search(ns, { limit: 1000 });
  const sequence = items.length;
  const key = makeControlKey(sequence);
  await store.put(ns, key, command as unknown as Record<string, any>);
}

export async function claimPendingControlCommands(
  store: BaseStore,
  namespace: string[],
  sessionId: string,
  threadId: string,
): Promise<ControlCommand[]> {
  const ns = getControlNamespace(namespace, sessionId);
  const items = await store.search(ns, { limit: 1000 });
  const claimed: ControlCommand[] = [];

  for (const item of items) {
    const cmd = item.value as unknown as ControlCommand;
    if (cmd.status !== "queued") continue;

    if (!matchesTarget(cmd.target, threadId, sessionId)) continue;

    const applied: ControlCommand = { ...cmd, status: "applied" };
    await store.put(ns, item.key, applied as unknown as Record<string, any>);
    claimed.push(applied);
  }

  return claimed;
}

function matchesTarget(
  target: ControlCommand["target"],
  threadId: string,
  sessionId: string,
): boolean {
  if (target === "all") return true;
  if (target === "active") return true;
  if (target === "root") return threadId === sessionId;
  if (typeof target === "object" && "threadId" in target) {
    return target.threadId === threadId;
  }
  return false;
}
