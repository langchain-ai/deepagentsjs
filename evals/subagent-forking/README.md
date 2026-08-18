# subagent-forking

Measures whether `mode: "fork"` actually helps, compared to the default
`mode: "handoff"` — on the same task, same model, three arms:

1. **handoff (baseline)** — the real orchestrator model writes the task
   `description` itself, the honest default behavior today.
2. **handoff + explicit instruction** — same as above, but the parent is told
   to put the exact facts in the description. Separates "forking helps" from
   "prompting the orchestrator better would have been enough."
3. **fork** — the subagent inherits the parent's full conversation instead of
   a hand-written description.

## The scenario

The parent has to read two files (`config.py`, `client.py`) to learn two
facts — a retry timeout value and an incident ID — that are never stated
together anywhere. It then delegates writing a runbook section to a
`runbook_writer` subagent. Getting the runbook right requires both facts to
survive the handoff.

## What's measured

Logged as LangSmith feedback per run, not collapsed into one score:

- `all_facts_present` / `fact_present:<fact>` — correctness
- `latency_ms` — wall-clock for the whole delegation
- `fresh_input_tokens`, `cache_read_tokens`, `cache_creation_tokens`,
  `output_tokens`, `cache_hit_rate` — cost and cache reuse (Anthropic-shaped
  usage; meaningless — will just read zero — on non-Anthropic runners)
- `exploration_tool_calls` — total `read_file`/`grep`/`glob`/`ls` calls across
  the whole run (parent + subagent); a handoff-mode subagent re-deriving
  facts it wasn't told shows up here as extra calls a forked one wouldn't need

Usage/tool-call totals are captured via a `BaseCallbackHandler`
(`UsageCollector` in [`metrics.ts`](./metrics.ts)) rather than the harness's
`AgentTrajectory`, because a subagent's own message list is excluded from the
parent's final state (see `EXCLUDED_STATE_KEYS` in `subagents.ts`) — but
callbacks propagate through the subagent's runnable regardless, so this is
the only way to see its calls at all.

## Running

Same as any other suite (see [`../README.md`](../README.md)) — needs
`EVAL_RUNNER`, `LANGSMITH_API_KEY`, and the API key for whichever model you
pick. Use an Anthropic runner (`sonnet-4-5`, etc.) to see non-zero cache
numbers — the fork feature's cache benefit is Anthropic/Bedrock-only.

```bash
EVAL_RUNNER=sonnet-4-5 pnpm --filter @deepagents/eval-subagent-forking test:eval
```

Each arm runs once per invocation — this is not yet repeated N times per
cell for statistical rigor (real API calls, real cost). Re-run manually to
get more samples, or aggregate across runs in the LangSmith experiment view.
