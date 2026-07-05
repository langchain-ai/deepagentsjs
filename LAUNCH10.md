# Launch10 fork of `deepagents`

This is a fork of [`langchain-ai/deepagentsjs`](https://github.com/langchain-ai/deepagentsjs).
This file documents **everything we changed on top of upstream** so the delta
is auditable and re-portable when we rebase onto a newer upstream.

- **Upstream remote:** `upstream` → `langchain-ai/deepagentsjs`
- **Our remote:** `origin` → `launch10/deepagentsjs`
- **Fork point (merge-base):** `ff7d82a7` (`build(deps): bump the minor-deps-updates-main group (#640)`) — upstream
  main as of 2026-07-05. Previous fork point was `9221c8a2` (#549); we re-based our
  delta onto current upstream (see `UPGRADE_PLAN.md`), keeping upstream's absorbed
  fixes (#608 subagent text forwarding, #598 native `run.subagents`, #566
  `lc_agent_name`) and layering our changes on top.

All paths below are under `libs/deepagents/src/`. To regenerate the raw diff:

```bash
git fetch upstream
git diff ff7d82a7 HEAD -- libs/deepagents/src
```

---

## Why we forked

Two production problems drove every change here:

1. **Parallel subagents crash on fan-in.** We dispatch N coder subagents in one
   superstep. Stock deepagents lets a subagent return arbitrary inherited state
   back to the parent. When several siblings echo the same plain `LastValue`
   channel in one step, LangGraph throws *"LastValue can only receive one value
   per step"* (we hit this on `error`, trace `fe0786e3`, and on `jwt`, trace
   `fa4945ba`).
2. **The default `task` tool destroys prompt-cache hit rate.** Its description
   and `subagent_type` schema field embed the live subagent roster. Two agents
   that share a system prompt (so they *should* share a cache prefix and a cost
   profile) but register different subagent sets end up with divergent tool
   bytes — the first cache breakpoint breaks and they never share cache.

Everything else is downstream of fixing those two, plus a dependency pin.

---

## Changes

### 1. Subagent return path is an allowlist, not a denylist

**File:** `middleware/subagents.ts` · **Test:** `middleware/subagentReturnState.test.ts`

Upstream filters subagent *return* state through a denylist (`EXCLUDED_STATE_KEYS`):
it strips a few known-bad keys and passes everything else back. That's fragile —
any newly-inherited parent field (a new id, a new flag) silently becomes a fan-in
crash the next time subagents run in parallel.

We replaced the return path with an **allowlist**:

```ts
export const RETURN_STATE_ALLOWLIST = ["todos", "files"] as const;
export function filterReturnState(state) { /* keep only allowlisted keys */ }
```

A subagent's contribution to the parent is exactly:
- its **final message** (handled separately as a `ToolMessage`), plus
- the **reducer-backed channels it legitimately accumulates into** — `todos`
  (parent's `todosReducer` merges by id) and `files` (`fileDataReducer` merges by
  path).

Everything else it carries is inherited *parent* context (`jwt`, `websiteId`,
`mode`, `accountId`, `error`, …) and is dropped. Because no parent scalar is ever
echoed back, future inherited fields can't reintroduce the crash class — this
fixes the whole category at the source rather than playing denylist whack-a-mole.

`returnCommandWithStateUpdate()` now calls `filterReturnState(result)` instead of
`filterStateForSubagent(result)`.

> **Note — the input path is still a denylist.** `filterStateForSubagent()`
> (state flowing *into* a subagent) intentionally stays a denylist: a child
> should inherit most of the parent's context minus a few keys
> (`skillsMetadata`, `memoryContents`, etc.). Allowlist on the way back,
> denylist on the way in.

> **Note —** `todos` was removed from `EXCLUDED_STATE_KEYS` (see change 3) so it
> can flow back through the allowlist.

---

### 2. Cache-prefix-stable `task` tool

**Files:** `middleware/subagents.ts`, `types.ts`, `agent.ts`

Two new optional overrides thread from `createDeepAgent` →
`createSubAgentMiddleware` → `createTaskTool`:

| Param | What it overrides | Default if unset |
| --- | --- | --- |
| `taskDescription` | the `task` tool's top-level prose description | upstream roster-bearing description |
| `subagentTypeDescription` | the `subagent_type` schema-field `.describe()` | `"Name of the agent to use. Available: <roster>"` |

The problem: both the tool description and the `subagent_type` field default to
embedding `Available: <roster>`. That roster differs per agent, so the serialized
tool bytes differ, so the prompt-cache prefix diverges one field apart — even
when two agents share an identical system prompt.

The fix: pass **roster-free constants** for both. The tool then serializes
byte-identically across agents regardless of which subagents they register, so
they share a cache prefix (and a cost profile). The actual roster is delivered
**out-of-band** — e.g. a tail reminder injected at runtime — rather than baked
into the tool schema.

Correctness is unaffected: `subagent_type` is still validated against the
registered graphs at dispatch time. We only removed the roster from the *cacheable
prompt bytes*, not from validation.

**You must set both together.** Setting only `taskDescription` leaves the roster
in the `subagent_type` field one level down and re-breaks the prefix.

---

### 3. Enhanced `todoListMiddleware` (UUIDs + merge-by-id reducer)

**File:** `middleware/todos.ts` (new) · exported from `index.ts` · wired in `agent.ts`

This *replaces* langchain's `todoListMiddleware` (note the import swap in
`agent.ts`: `from "langchain"` → `from "./middleware/todos.js"`). It adds:

1. **Auto-generated UUIDs.** `write_todos` stamps `id: t.id || randomUUID()` on
   every todo so todos are individually addressable across parallel updates.
2. **A `ReducedValue` `todos` channel with a merge-by-id reducer**
   (`todosReducer`). Instead of last-write-wins, parallel updates merge:
   - existing ids update in place; new ids append;
   - **status never downgrades.** Priority is `completed(2) > in_progress(1) >
     pending(0)`. Parallel subagents act on stale snapshots, so a late update
     must not move a todo backward (e.g. `completed → in_progress`).
3. **An `afterModel` guard** that rejects *parallel* `write_todos` tool calls in
   a single model turn (returns error `ToolMessage`s). The full list must be
   written atomically in one call.

> This is the **[pre-existing]** reconciliation mechanism — the id + merge-by-id
> reducer is what lets streaming todos from subagents reconcile back into the
> parent without clobbering. Changes 1 and 4 depend on it.

The exported `TodoListMiddlewareOptions` allows `systemPrompt` / `toolDescription`
overrides (kept for parity with upstream).

---

### 4. Subagent → parent todo reconciliation + real-time streaming

**File:** `middleware/subagents.ts`

The `task` tool gained an optional `todo_id` parameter. When the dispatcher
passes the parent todo id it's delegating:

- When the subagent finishes, the matching parent todo is auto-flipped to
  `completed` in the returned `todos` (which then merge back via the reducer from
  change 3).
- That flip is **also emitted immediately through the graph stream writer** as a
  `__state_patch__` event, *bypassing the `Promise.all` batching* of the parallel
  dispatch. Without this, the frontend only sees todos flip after *every* sibling
  subagent resolves; with it, each todo flips the moment its subagent finishes.

To make that work we had to **capture the stream writer before
`subagent.invoke()`**: the subagent's graph invocation replaces the
`AsyncLocalStorage` context, so `getWriter()` returns `undefined` after `invoke()`
returns. We grab it up front and tolerate both the function-style and
`.write()`-style writer shapes.

---

### 5. Per-dispatch `callerId` for shared-backend optimistic concurrency

**File:** `middleware/subagents.ts`
**Consumer (verified in use):** `langgraph_app/app/services/backends/callerContext.ts`
and `virtualFilesBackend.ts`

Each `task` dispatch now stamps a fresh `callerId: randomUUID()` into
`subagentConfig.configurable`. Stock deepagents mints no stable per-sync-subagent
identity — a spawned coder just inherits the parent's `configurable` — so a shared
backend can't tell parallel coders apart. Putting it in `configurable` makes it
ambient (readable via `getConfig()` for the subagent's whole run), and every
dispatch, including nested sub-coders, gets a distinct one.

**This is actively consumed**, not speculative. `langgraph_app` shares one
`VirtualFilesBackend` instance across the main agent and every parallel coder
dispatch. The backend does optimistic-concurrency control (OCC) on writes: it
tracks, *per caller*, the shasum version each caller read, and sends that as the
`expected_shasum` compare-and-swap on write. Without a per-caller id, the
shasum store is keyed only by path, so coder B inherits coder A's post-write
shasum and silently clobbers A's change (lost update). `callerContext.ts` reads
our stamped id via `getConfig()` (`currentCallerId()`), falling back to
`DEFAULT_CALLER_ID = "root"` for the main top-level invoke that carries no
`callerId`. Subagent fan-out is the *normal* mode there, so this is the common
path, not an edge case.

> **Rebase implication:** this is a hard dependency of the consuming app. If a
> future upstream starts minting its own subagent identity under a different
> `configurable` key, update `callerContext.ts` to read it instead of removing
> our stamp.

---

### 6. Dependency: `zod` — resolved (manifest matches upstream, runtime is v4)

**Files:** `libs/deepagents/package.json`

**Post-upgrade state (ff7d82a7):** the manifest carries upstream's `zod`
`^4.3.6`; the launch10 monorepo root override still forces `zod@4.4.3` at
runtime. We dropped the fork's cosmetic `"zod/v4"` → `"zod"` import flips
(`testing/utils.ts`, `agent.test-d.ts`) — on a v4 runtime both subpaths resolve
to the same API, so keeping upstream's imports minimizes divergence. The stale
`3.25.76` pin described below is gone.

Historical note (pre-upgrade):
- `libs/deepagents/package.json` had once pinned `zod` to `3.25.76`, overridden
  at runtime by the monorepo root override to `zod@4.4.3` — misleading but
  runtime-moot inside the monorepo.

**The declared `3.25.76` pin is overridden and misleading. deepagents actually
loads `zod@4.4.3` at runtime.** The launch10 monorepo root
(`/Users/.../launch10/package.json`) carries a workspace-wide pnpm override:

```json
"pnpm": { "overrides": {
  "zod": "4.4.3",
  "miniflare>zod": "3.25.76",
  "@cloudflare/vitest-pool-workers>zod": "3.25.76"
}}
```

`packages/deepagentsjs/libs/deepagents` is a member of that root workspace
(matched by `packages/*/libs/*`), so the override wins: the live symlink
`libs/deepagents/node_modules/zod` points at `zod@4.4.3`. `langgraph_app`
resolves 4.4.3 the same way. Only Cloudflare Workers tooling stays on 3.25.76.

Because the runtime zod is 4.4.3, both `from "zod"` and `from "zod/v4"` resolve
to the v4 API — which is why the mixed imports work. The `3.25.76` text in
deepagents' `package.json` is a leftover from when the workspace was on zod 3;
it no longer reflects reality.

**Recommended cleanup:** bump `libs/deepagents/package.json` `zod` to `^4.4.3`
(or `^4.3.6`, matching upstream's range) so the manifest stops lying. This is
runtime-moot inside the monorepo (the override already forces 4.4.3) but matters
if deepagents is ever consumed standalone — a downstream consumer would install
zod 3 from the pin, and `from "zod"` would then hand them the v3 API while
`from "zod/v4"` hands them v4, a split-brain that only surfaces outside this
repo. Tracked as open cleanup below.

> **Rebase note:** upstream is on zod `^4.3.6`. A naive merge that restores the
> upstream pin is actually *more correct* than our `3.25.76` — don't fight it.

---

## Rebase checklist

When pulling a newer upstream, re-verify each item survives:

- [ ] Return path still uses `filterReturnState` (allowlist), not the upstream
      denylist, in `returnCommandWithStateUpdate`.
- [ ] `RETURN_STATE_ALLOWLIST` still matches the reducer-backed channels
      (`todos`, `files`) — extend it only if you add a new *reducer-backed* channel.
- [ ] `taskDescription` / `subagentTypeDescription` overrides still thread
      through `createDeepAgent` → `createSubAgentMiddleware` → `createTaskTool`,
      and our callers still pass roster-free constants for both.
- [ ] `agent.ts` still imports `todoListMiddleware` from `./middleware/todos.js`,
      not from `langchain`.
- [ ] `task` tool still accepts `todo_id`; writer is still captured *before*
      `subagent.invoke()`.
- [ ] `callerId` is still stamped into `configurable`.
- [ ] `zod`: runtime is 4.4.3 via the launch10 root override — verify the
      override still lists `"zod": "4.4.3"`. The deepagents manifest pin is
      cosmetic; prefer upstream's `^4.x` range over our stale `3.25.76`.
