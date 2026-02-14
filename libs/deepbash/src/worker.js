Error.stackTraceLimit = 50;
globalThis.onerror = console.error;

let pendingMessages = [];
let worker = undefined;
let handleMessage = async data => {
  if (worker) {
    try {
      await worker.handle(data);
    } catch (e) {
      console.error('[deepbash worker] Error handling message:', e);
    }
  } else {
    // We start off by buffering up all messages until we finish initializing.
    pendingMessages.push(data);
  }
};

globalThis.onmessage = async ev => {
  if (ev.data.type == "init") {
    try {
      const { memory, module, id, sdkUrl } = ev.data;
      const sdk = await import(sdkUrl);
      const init = sdk.default || sdk.init;
      const { ThreadPoolWorker } = sdk;
      await init({ module_or_path: module, memory: memory });

      worker = new ThreadPoolWorker(id);

      // Now that we're initialized, we need to handle any buffered messages
      for (const msg of pendingMessages.splice(0, pendingMessages.length)) {
        try {
          await worker.handle(msg);
        } catch (e) {
          console.error('[deepbash worker] Error handling buffered message:', e);
        }
      }
    } catch (e) {
      console.error('[deepbash worker] Error during initialization:', e);
    }
  } else {
    // Handle the message like normal.
    await handleMessage(ev.data);
  }
};
