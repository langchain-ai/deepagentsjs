import type { ACPAttachedSession } from "deepagents";

import type { WebUIRuntime, WebUIRuntimeOptions } from "./types.js";
import { startViteWebUIServer } from "./vite-server.js";

export function createWebUIRuntime(args: {
  attach: () => ACPAttachedSession;
  options?: WebUIRuntimeOptions;
}): WebUIRuntime {
  const { attach, options } = args;
  let attached: ACPAttachedSession | undefined;
  let runtime:
    | Awaited<ReturnType<typeof startViteWebUIServer>>
    | undefined;

  return {
    get url() {
      return runtime?.url;
    },
    async start() {
      if (runtime) return;
      attached = attach();
      runtime = await startViteWebUIServer({
        attached,
        options,
      });
    },
    async stop() {
      await runtime?.stop();
      runtime = undefined;
      attached?.close();
      attached = undefined;
    },
  };
}
