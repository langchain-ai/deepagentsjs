# all

Aggregate eval runner package that executes all suites in a single Vitest + LangSmith run.

This package sets:

- `LANGSMITH_EVAL_PROJECT=deepagents-js-all`
- `LANGSMITH_EVAL_DATASET=deepagents-js-all`

so all suites report into one shared LangSmith experiment target when run through
`@deepagents/eval-all`.
