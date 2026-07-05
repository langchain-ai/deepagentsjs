# Upgrade plan: rebase launch10 fork onto current upstream

Goal: move our fork from fork-point `9221c8a2` up to current upstream
`langchain-ai/deepagentsjs` main, **replaying only our logical changes** and
letting upstream's new features come for free. Upstream is ~44 commits ahead
(~20 substantive). None of our 6 changes are made redundant by upstream, but
two of ours live in code upstream rewrote, so those are re-port (not cherry-pick).

## Strategy: reset + reapply the net delta, do NOT `git rebase` the commits

Our history since the fork is not replayable commit-by-commit:
- an upstream merge (`8ab020ff`) is already baked into it,
- the "Cache prewarming" `subagentWarmGate.ts` was added (`bd0b726a`) then
  removed — net-zero, **skip entirely**,
- `LAUNCH10.md` is stale (says zod pin `3.25.76`; the manifest is already
  `^4.4.3`).

So the ground truth is the **net diff**, not the commit log:

```bash
git diff 9221c8a2 HEAD -- libs/deepagents/src   # 11 files, our real delta
```

We reset onto new upstream and reapply those 11 files' intent as a small set of
clean commits.

## The net delta (11 files) and how each is handled

| File | Our change | Upstream touched it? | Action |
| --- | --- | --- | --- |
| `middleware/todos.ts` | new: enhanced todo middleware (UUID + merge-by-id reducer + parallel-write guard) | no (new file) | **copy as-is** |
| `middleware/subagentReturnState.test.ts` | new test | no (new file) | **copy as-is** |
| `backends/filesystem.ts` (+`.test`) | hide `node_modules` from glob/ls/grep FS view | **no** (upstream changed composite/utils, not filesystem.ts) | **cherry-pick clean** |
| `testing/utils.ts` | zod import | trivial | trivial reapply |
| `agent.test-d.ts` | types test tweak | yes (+38, stateSchema tests) | reapply small hunk |
| `index.ts` | export enhanced todos middleware | yes (+6) | reapply 1-2 lines |
| `types.ts` | `taskDescription`/`subagentTypeDescription` option types | yes (+55) | reapply small hunk |
| `middleware/fs.ts` | grep tool description → "ripgrep regex" | yes (+147, eviction) | **re-port** the one string |
| `agent.ts` | import-swap todos middleware; thread 2 task-tool overrides; wire enhanced todos | **yes, heavy** (#569/#611/#598) | **re-port** |
| `middleware/subagents.ts` | 4 logical changes (below) | **yes, heavy** (#608/#598/#591/#566) | **re-port — the hard one** |

## "Minus the changes you listed" — keep/drop decisions

Upstream's new work that intersects ours. Explicit calls so we don't fight it:

- **KEEP upstream #608 (forward subagent result as text).** It rewrote the
  *message-content* half of `returnCommandWithStateUpdate` to fix a real
  Anthropic 400. Our allowlist change touches the *state* half of the same
  function. Layer ours on top — do **not** revert theirs.
- **KEEP upstream #598 (native `run.subagents`, transformer + `stream.ts`
  deleted).** Our real-time todo streaming (change #4) hung off the old
  transformer/writer path. Re-anchor our `getWriter()`-before-`invoke()` capture
  onto the new path; don't try to resurrect the old `stream.ts`.
- **KEEP upstream #566 (`metadata.lc_agent_name = subagent_type`).** It's
  adjacent to — not a replacement for — our `callerId`. Our `callerId` stays in
  `configurable`; their name stays in `metadata`. Keep both.
- **KEEP upstream #591 (`createSubAgent` exported)** and **#569 (`stateSchema`)** —
  free, no conflict with us. (`stateSchema` is a future opportunity to move our
  custom channels out of the fork — out of scope for this upgrade.)
- **DROP our warm gate** (`subagentWarmGate.*`) — already net-removed in our HEAD.
- **DROP the zod pin gymnastics.** Take upstream's `zod` range (`^4.3.6`) or keep
  our `^4.4.3`; both resolve to v4. Delete the stale `3.25.76` narrative.

## Step-by-step

### 0. Prep
```bash
cd packages/deepagentsjs
git fetch upstream
git checkout -b upgrade/upstream-$(date +%Y%m%d) upstream/main   # target = upstream main HEAD
git tag pre-upgrade-backup <current-fork-HEAD>                    # safety
# capture ground truth for reference during re-port:
git diff 9221c8a2 <current-fork-HEAD> -- libs/deepagents/src > /tmp/launch10-delta.patch
```

### 1. Land the no-conflict files (mechanical)
Copy/cherry-pick these from the old HEAD; they apply clean on new upstream:
- `middleware/todos.ts`, `middleware/subagentReturnState.test.ts` (new files)
- `backends/filesystem.ts` + `backends/filesystem.test.ts` (node_modules hiding —
  upstream did **not** touch filesystem.ts)
- `testing/utils.ts`
```bash
git checkout <old-HEAD> -- \
  libs/deepagents/src/middleware/todos.ts \
  libs/deepagents/src/middleware/subagentReturnState.test.ts \
  libs/deepagents/src/backends/filesystem.ts \
  libs/deepagents/src/backends/filesystem.test.ts \
  libs/deepagents/src/testing/utils.ts
```
Commit as: `chore(fork): re-land todos middleware, node_modules FS hiding, tests`.

### 2. Re-port `middleware/subagents.ts` (the hard one)
Re-apply our four logical changes onto upstream's rewritten file. Anchors in the
current upstream file:

1. **Return-state allowlist.** `returnCommandWithStateUpdate` (~L444) calls
   `filterStateForSubagent(result)` (~L448) for the state update. Swap that call
   to our `filterReturnState(result)` and add `RETURN_STATE_ALLOWLIST =
   ["todos","files"]`. **Leave upstream's text-forwarding (#608) in the same
   function untouched.** Leave the *input* path (`filterStateForSubagent`, ~L420)
   as the denylist — allowlist out, denylist in.
2. **Cacheable task tool.** In `createTaskTool` (~L625): default the tool's prose
   description and the `subagent_type` `.describe()` (~L754) from our
   `taskDescription` / `subagentTypeDescription` options (roster-free constants).
   Validation against `subagentGraphs` (~L690) stays.
3. **`callerId` for OCC.** At the `subagent.invoke` config (~L711, the
   `configurable:` spread) stamp `callerId: randomUUID()`. Keep upstream's
   sibling `metadata.lc_agent_name` (~L709).
4. **`todo_id` + real-time writer streaming.** Add the `todo_id` tool param;
   capture the graph stream writer **before** `subagent.invoke()` (~L716, since
   invoke swaps the ALS context); on finish, flip the matching parent todo to
   `completed`, merge via the reducer, and emit the `__state_patch__` immediately.
   Re-anchor onto the native `run.subagents` path (#598), not the deleted transformer.

Verify against `subagentReturnState.test.ts` after.

### 3. Re-port `agent.ts`
On upstream's new `agent.ts`:
- swap **both** `todoListMiddleware()` call sites (~L261 and ~L341) from the
  `langchain` import (~L7) to our `./middleware/todos.js`;
- thread `taskDescription` / `subagentTypeDescription` from `createDeepAgent`
  params into `createSubAgentMiddleware({...})` (~L345);
- keep upstream's new wiring (stateSchema, cache/bedrock middleware, async subagents).

### 4. Re-port the small hunks
- `types.ts`: add the two override option types.
- `index.ts`: export the enhanced todos middleware + its options type.
- `middleware/fs.ts`: change the grep tool description to the "ripgrep regex"
  wording (one string; find upstream's current grep-tool description block).
- `agent.test-d.ts`: reapply our type-test tweak.
- `libs/deepagents/package.json`: take upstream's zod range; keep our `callerId`
  dep bump if any.

### 5. Verify
```bash
pnpm install
pnpm -C libs/deepagents build           # typecheck the re-ports
pnpm -C libs/deepagents test -- \
  subagentReturnState todos filesystem fs subagent   # our touched areas
```
Then run the **LAUNCH10.md rebase checklist** (7 items) as the acceptance gate:
allowlist return path, `RETURN_STATE_ALLOWLIST` = reducer-backed channels only,
both task-tool overrides thread through, todos import from `./middleware/todos.js`,
`todo_id` + writer-captured-before-invoke, `callerId` in `configurable`, zod is v4.

### 6. Verify the downstream consumer (do not skip)
Our `callerId` is a hard dependency of `langgraph_app`:
`langgraph_app/app/services/backends/callerContext.ts` reads it via `getConfig()`
(`currentCallerId()`), and `virtualFilesBackend.ts` uses it for per-caller OCC
shasum tracking. After bumping the submodule, run a parallel-coder fan-out and
confirm no lost-update / no "LastValue can only receive one value per step" crash.

### 7. Update docs
- Bump `LAUNCH10.md` fork-point to the new upstream SHA; correct the zod section
  (manifest is `^4.4.3`, not `3.25.76`).
- Delete this file or fold it into the rebase-checklist once green.

## Risk ranking
1. **`subagents.ts` re-port** — high. Concentrate review here; it's where #598,
   #608, #566 and all four of our changes collide.
2. **`agent.ts` todos wiring** — medium (two call sites, new neighbors).
3. Everything else — low/mechanical.
