# all

Aggregate eval runner package that executes all suites via one top-level
`ls.describe` block in `index.test.ts`, so the run lands in one LangSmith
experiment target.

Each suite exports a `define...Suite(runner)` function from a separate `suite.ts`
file. `evals/all/index.test.ts` imports those functions and invokes them directly.
