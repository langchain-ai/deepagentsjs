---
"deepagents": minor
---

feat(deepagents): reload skills when `skillsMetadata` is set to `null`

Skills are loaded once per thread and kept in state, so a long-lived thread never saw skills added, edited or deleted after its first run. Setting `skillsMetadata` to `null` now makes the next model call re-read every source and replace the stored list. A thread whose sources hold no skills also counts as loaded, so it stops listing the backend on every run — including threads checkpointed by earlier versions, which store `[]` and need an explicit `null` to reload.

Loading moved from `beforeAgent` to `beforeModel`, matching Python's `SkillsMiddleware`, so a reload is served by the next model call rather than the next run. Two consequences:

- A middleware of your own can invalidate mid-run, from `afterModel`, and the following model call sees the fresh list.
- With a `StateBackend`, a load now sees `files` written during the run, so a `SKILL.md` the agent just wrote is picked up.

One gap remains: a `jumpTo: "model"` from an `afterModel` hook routes straight to the model node and bypasses `beforeModel`, so a reload pending at that moment is not served until the iteration after. `humanInTheLoopMiddleware` jumps this way when a tool call is rejected, so a reload requested during a review interrupt is skipped for that one model call.

A fork inherits a pending invalidation: a fork spawned in the same iteration that set `skillsMetadata` to `null` reloads from its own sources rather than inheriting the parent's last loaded list.

`skillsMetadata` is also part of the agent's state type now when `skills` is passed to `createDeepAgent`, which previously meant mounting `createSkillsMiddleware` by hand to reach it. Inference mirrors the runtime condition, so an omitted option or an empty literal contributes no state, while a non-literal `string[]` does.

A middleware of your own can reach the field too: `skillsMetadataValue` is exported for declaring `skillsMetadata` on a custom middleware's state schema, since a middleware can only read and write the fields its own schema declares. Treat the value as opaque — it exists to be passed to `StateSchema`, and its concrete type may change.
