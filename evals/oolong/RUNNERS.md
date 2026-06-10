# Oolong Eval Runners

## Available runners

| Runner | Strategy | Notes |
|---|---|---|
| `claude-sonnet-4-6-swarm` | Built-in swarm library | Uses `import { create, run, reduce } from "swarm"` inside QuickJS |
| `claude-sonnet-4-6-ptc` | PTC + subagent instructions | `tools.subagent` with fan-out patterns |
| `claude-sonnet-4-6-ptc-swarm` | PTC + subagent + swarm-repl instructions | Swarm-style `create/run/rows/reduce` helpers written directly in the REPL using `tools.subagent` |
| `claude-sonnet-4-6-ptc-direct` | PTC + REPL-direct instructions | Reads `/context.txt` once, solves structural tasks in pure JS, batches classification tasks 100 items per subagent call |

### Strategy notes

**`ptc-direct`** is designed specifically for Oolong's task structure:
- ~48% of tasks (user/timeline) are solvable with zero subagents — just `readFile` + JS `Map` aggregation over the `Date:`/`User:` fields already in each line.
- ~52% of tasks (classification) require LLM inference per item, but batch 100 items per `tools.subagent` call instead of 1, reducing total calls from O(N) to O(N/100).

**`ptc-swarm`** is the general multi-stage fan-out pattern. Better suited to tasks where earlier classification passes filter later deeper passes.

## Running

From the repo root:

```bash
LANGSMITH_API_KEY=<key> \
  EVAL_RUNNER=<runner> \
  OOLONG_MAX_PER_DATASET=10 \
  OOLONG_CONTEXT_LEN=65536 \
  pnpm --filter @deepagents/eval-oolong test:eval datasets/trec_coarse.eval.test.ts
```

Or from `evals/oolong/`:

```bash
LANGSMITH_API_KEY=<key> \
  EVAL_RUNNER=<runner> \
  OOLONG_MAX_PER_DATASET=10 \
  OOLONG_CONTEXT_LEN=65536 \
  pnpm test:eval datasets/trec_coarse.eval.test.ts
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `EVAL_RUNNER` | (required) | Runner name from the table above |
| `LANGSMITH_API_KEY` | (required) | Personal LangSmith API key — results won't appear in LangSmith without this |
| `OOLONG_MAX_PER_DATASET` | `10` | Max tasks per dataset. Set to `0` for all |
| `OOLONG_CONTEXT_LEN` | (all) | Filter to a specific context length bucket |

## Available datasets

Only `spam` and `trec_coarse` are available in the `partial-validation` HuggingFace split. The other dataset files (`metaphors`, `agnews`, `imdb`, etc.) exist in the codebase but have no data at any context length in the current split.

| Dataset | Available context lengths |
|---|---|
| `trec_coarse` | 1024 – 4194304 |
| `spam` | 1024 – 4194304 |

## LangSmith projects

Results are grouped by dataset, with each runner as a separate experiment:

| Test file | LangSmith project |
|---|---|
| `datasets/trec_coarse.eval.test.ts` | `deepagents-js-oolong-trec-coarse` |
| `datasets/agnews.eval.test.ts` | `deepagents-js-oolong-agnews` |
| others | `deepagents-js-oolong-<dataset>` |

The experiment name within each project is the runner name (e.g. `claude-sonnet-4-6-ptc-direct`), so you can compare runners side-by-side in LangSmith.

> **Note:** LangSmith only creates the project when the first run completes. Output is buffered by vitest until all tests in the file finish — expect a few minutes before traces appear, longer for large context lengths.
