---
"deepagents": minor
---

feat(deepagents): reload skills when `skillsMetadata` is set to `null`

Skills are loaded once per thread and kept in state, so a long-lived thread never saw skills added, edited or deleted after its first run. Setting `skillsMetadata` to `null` between runs now makes the next run re-read every source and replace the stored list. A thread whose sources hold no skills also counts as loaded, so it stops listing the backend on every run — including threads checkpointed by earlier versions, which store `[]` and need an explicit `null` to reload.

`skillsMetadata` is also part of the agent's state type now when `skills` is passed to `createDeepAgent`, which previously meant mounting `createSkillsMiddleware` by hand to reach it. Inference mirrors the runtime condition, so an omitted option or an empty literal contributes no state, while a non-literal `string[]` does.

A middleware of your own can reach the field too: `skillsMetadataValue` is exported for declaring `skillsMetadata` on a custom middleware's state schema, since a middleware can only read and write the fields its own schema declares. Treat the value as opaque — it exists to be passed to `StateSchema`, and its concrete type may change.
