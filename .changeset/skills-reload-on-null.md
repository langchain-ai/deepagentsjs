---
"deepagents": minor
---

feat(deepagents): reload skills when `skillsMetadata` is set to `null`

`createSkillsMiddleware` loads skills once per thread and keeps them in state, so a long-lived thread never saw skills added, edited or deleted after its first run. Set `skillsMetadata` to `null` between runs, and the next run reads every source again and replaces the stored list:

```ts
await agent.updateState(config, { skillsMetadata: null });
// or as part of the next run's input
await agent.invoke({ messages, skillsMetadata: null }, config);
```

A thread whose sources had no skills now counts as loaded, so it stops listing the backend on every run. This includes threads checkpointed by earlier versions, which store `[]`. Set `skillsMetadata` to `null` to make one of those threads load again.

If you pass `createSkillsMiddleware` to an agent yourself, `skillsMetadata` on the `invoke` result is now typed `SkillMetadataEntry[] | null | undefined`. Reads that use `?.` or `?? []` still compile. A check like `skillsMetadata !== undefined` followed by `.length` doesn't.
