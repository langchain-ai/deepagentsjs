# all

Aggregate eval runner package that executes all suites via one top-level
`ls.describe` block in `eval.test.ts`, so the run lands in one LangSmith
experiment target.

Each suite exports a `define...Suite(runner)` function from a separate `index.ts`
file. `evals/all/eval.test.ts` imports those functions and invokes them directly.
