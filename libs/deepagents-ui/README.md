# deepagents-ui

`deepagents-ui` provides a thin consumer layer on top of the ACP-friendly
`SessionHandle` surface from `deepagents`.

```ts
import { middleman } from "deepagents-ui";
```

It is designed for local-first observer sessions:

- observe-only by default
- steering must be enabled explicitly
- a simple local Vite-based web UI can be started for an existing session
- the UI consumes the same session attachment path as any other client

## Example

```ts
import { createSessionHandle } from "deepagents";
import { middleman } from "deepagents-ui";

const session = createSessionHandle({ sessionId, store });
const ui = middleman({ session });

await ui.createWebUI({ port: 3000, open: true }).start();
```
