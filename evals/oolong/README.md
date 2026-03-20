# oolong

Implementation of [Oolong: Evaluating Long Context Reasoning and Aggregation Capabilities](https://arxiv.org/abs/2511.02817) by Amanda Bertsch, Adithya Pratapa, Teruko Mitamura, Graham Neubig, and Matthew R. Gormley (2025).

> As model context lengths continue to grow, concerns about whether models
> effectively use the full context length have persisted. Oolong is a benchmark
> of long-context reasoning tasks that require analyzing individual chunks of
> text on an atomic level, and then aggregating these analyses to answer
> distributional questions.

Uses the [oolong-synth](https://huggingface.co/datasets/oolongbench/oolong-synth) dataset
from HuggingFace. The agent receives a large `context_window_text` as a seeded file and must
answer aggregation questions (counting, frequency, temporal, user-based).

## Structure

Each source dataset has its own test file under `datasets/`:

| File                           | Source dataset                    |
| ------------------------------ | --------------------------------- |
| `datasets/spam.test.ts`        | SMS spam classification           |
| `datasets/trec_coarse.test.ts` | TREC question type classification |
| `datasets/agnews.test.ts`      | AG News topic classification      |
| `datasets/imdb.test.ts`        | IMDB sentiment                    |
| `datasets/negation.test.ts`    | HiTZ negation detection           |
| `datasets/yahoo.test.ts`       | Yahoo Answers topics              |
| `datasets/formality.test.ts`   | Pavlick formality                 |
| `datasets/multinli.test.ts`    | MultiNLI entailment               |
| `datasets/metaphors.test.ts`   | BigBench metaphor interpretation  |
| `datasets/app_reviews.test.ts` | App review sentiment              |

Data loading is handled by `loadOolongTasksByDataset()` in `load-oolong.ts`
which caches at the module level, so multiple test files share the same data.
The shared test logic lives in `make-tests.ts`.

## Running

```bash
# Run all datasets
EVAL_RUNNER=sonnet-4-5 pnpm --filter @deepagents/eval-oolong test:eval

# Run a single dataset
EVAL_RUNNER=sonnet-4-5 pnpm --filter @deepagents/eval-oolong test:eval -- datasets/spam.test.ts

# Run all validation tasks (~1300)
OOLONG_MAX_PER_DATASET=0 EVAL_RUNNER=sonnet-4-5 pnpm --filter @deepagents/eval-oolong test:eval

# Custom subset size
OOLONG_MAX_PER_DATASET=5 EVAL_RUNNER=sonnet-4-5 pnpm --filter @deepagents/eval-oolong test:eval
```

## Environment variables

| Variable                 | Default    | Description                                                |
| ------------------------ | ---------- | ---------------------------------------------------------- |
| `EVAL_RUNNER`            | (required) | Model runner to use (e.g. `sonnet-4-5`, `opus-4-6`)        |
| `OOLONG_MAX_PER_DATASET` | `10`       | Max tasks per source dataset. Set to `0` for all.          |
| `OOLONG_CONTEXT_LEN`     | (all)      | Filter to a specific `context_len` (e.g. `1024`, `131072`) |

## Scoring

Scoring is ported from the [official Oolong eval harness](https://github.com/abertsch72/oolong/blob/main/src/eval/eval_helpers.py) (`synth_process_response`) to ensure results are directly comparable to the paper.

1. **Answer parsing** -- split on `:` and take the last segment; strip markdown/bracket artifacts
2. **Exact match** -- `str(parsed) == str(gold)` after parsing
3. **Comparison answers** (`ANSWER_TYPE.COMPARISON`) -- substring containment for "more common than" / "less common than" / "same frequency as"
4. **Numeric answers** (`ANSWER_TYPE.NUMERIC`) -- partial credit via `0.75^|gold - pred|`
5. **Date answers** (`ANSWER_TYPE.DATE`) -- flexible date parsing comparison

A prediction is scored 1.0 for exact/comparison/date matches, partial credit
for near numeric answers, and 0 otherwise. The test assertion requires a
perfect score (1.0).

## Citation

```bibtex
@article{bertsch2025oolong,
  title={Oolong: Evaluating Long Context Reasoning and Aggregation Capabilities},
  author={Bertsch, Amanda and Pratapa, Adithya and Mitamura, Teruko and Neubig, Graham and Gormley, Matthew R.},
  journal={arXiv preprint arXiv:2511.02817},
  year={2025}
}
```

## Adaptations

- Uses the `oolong-synth` validation split (all source datasets, not just `trec_coarse`)
- Defaults to a 10-task-per-dataset subset for cost efficiency
- Context is seeded as an `initialFile` rather than a REPL VFS
- Agent uses the standard `getDefaultRunner()` harness rather than a custom RLM agent
