import type {
  ACPAttachedSession,
  AttachedClientInfo,
} from "deepagents";

import { createWebUIRuntime } from "./web-ui.js";
import type {
  MiddlemanAttachOptions,
  MiddlemanOptions,
  MiddlemanRuntime,
} from "./types.js";

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === "function";
}

async function resolveBoolean(
  value: boolean | Promise<boolean> | undefined,
  fallback: boolean,
): Promise<boolean> {
  if (value === undefined) return fallback;
  return isPromise(value) ? await value : value;
}

function buildClient(
  client: Partial<AttachedClientInfo> | undefined,
  transport: string,
): AttachedClientInfo {
  return {
    id: client?.id ?? `${transport}-client`,
    name: client?.name,
    transport,
    capabilities: client?.capabilities,
  };
}

export function middleman(options: MiddlemanOptions): MiddlemanRuntime {
  const {
    session,
    permissions,
    allowSteering: runtimeAllowsSteering = false,
  } = options;

  function attachACPClient(
    attachOptions: MiddlemanAttachOptions = {},
  ): ACPAttachedSession {
    const client = buildClient(attachOptions.client, attachOptions.client?.transport ?? "acp");
    let core: ACPAttachedSession | undefined;
    let closed = false;

    const ensureCore = async (): Promise<ACPAttachedSession> => {
      if (closed) {
        throw new Error(`Client "${client.id}" has already been closed.`);
      }

      if (core) return core;

      const defaultObserve = permissions?.defaultAccess !== "none";
      const observeAllowed = await resolveBoolean(
        permissions?.canObserve?.(client),
        defaultObserve,
      );
      if (!observeAllowed) {
        throw new Error(`Observation denied for client "${client.id}".`);
      }

      core = session.attachACPClient({
        ...attachOptions,
        client,
        allowSteering:
          runtimeAllowsSteering && (attachOptions.allowSteering ?? false),
      });
      return core;
    };

    const ensureSteeringAllowed = async (): Promise<void> => {
      if (!(runtimeAllowsSteering && (attachOptions.allowSteering ?? false))) {
        throw new Error(
          `Steering is disabled for client "${client.id}". Enable it explicitly in middleman() and attachACPClient().`,
        );
      }

      const steerAllowed = await resolveBoolean(
        permissions?.canSteer?.(client),
        true,
      );
      if (!steerAllowed) {
        throw new Error(`Steering denied for client "${client.id}".`);
      }
    };

    return {
      client,
      async getInitialUpdates() {
        return await (await ensureCore()).getInitialUpdates();
      },
      async poll(input: Parameters<ACPAttachedSession["poll"]>[0]) {
        return await (await ensureCore()).poll(input);
      },
      subscribe(listener: Parameters<ACPAttachedSession["subscribe"]>[0]) {
        let unsubscribe: (() => void) | undefined;
        void ensureCore()
          .then((attached) => {
            unsubscribe = attached.subscribe(listener);
          })
          .catch(() => {});

        return () => {
          unsubscribe?.();
        };
      },
      async steer(input: Parameters<ACPAttachedSession["steer"]>[0]) {
        await ensureSteeringAllowed();
        return (await ensureCore()).steer(input);
      },
      async lifecycle(operation: string) {
        return (await ensureCore()).lifecycle(operation);
      },
      close() {
        closed = true;
        core?.close();
      },
    };
  }

  return {
    session,
    attachACPClient,
    createWebUI(uiOptions) {
      return createWebUIRuntime({
        attach: () =>
          attachACPClient({
            client: buildClient(uiOptions?.client, "web-ui"),
            allowSteering: uiOptions?.allowSteering ?? false,
            historyLimit: uiOptions?.historyLimit,
            pollIntervalMs: uiOptions?.pollIntervalMs,
          }),
        options: uiOptions,
      });
    },
  };
}
