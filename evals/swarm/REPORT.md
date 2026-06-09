# Swarm Evaluation

## The question

Does the swarm abstraction actually help an agent coordinate many subagents, or is a plain dispatch tool good enough? We want a clear, fair answer before investing further.

## What swarm is

Swarm gives the agent a small table based API (create, run, rows) for fanning work out across many items. The data stays in the sandbox, so the orchestrator's context stays lean as the workload grows.

## The two conditions

Same agent, same model, same data. The only thing that changes is the orchestration layer.

- **Swarm.** The full table abstraction.
- **Baseline.** The same dispatch primitive with no table layer. The agent composes everything by hand in JavaScript.

Both sides get identical dispatch capability (structured output, agent and invoke modes), identical tools, identical subagents, and matched guidance. So a swarm win means the abstraction earns its place. A tie means we should just ship the primitive.

## Workflow patterns

Five common multi agent jobs.

- **Classify and act.** Sort items, then act on the urgent ones.
- **Fanout and synthesize.** Review every file, then summarize.
- **Adversarial verification.** Find issues, then independently confirm them.
- **Generate and filter.** Produce many candidates, dedupe to the best.
- **Loop until done.** Keep searching until nothing new turns up.

## Scale

Each pattern runs at 50, 200, 500, and 1000 items. The goal is to find where the abstraction starts to matter. Small workloads should look similar across conditions. As the data grows past what fits comfortably in one context, the baseline orchestrator should start to struggle while swarm holds steady.

## Data

Procedurally generated with a fixed seed, so both conditions see identical inputs and every run reproduces. Files are varied and realistic with known answers planted inside, which lets us score accuracy exactly.

## What we measure

- **Coverage and recall.** Did it find everything.
- **Precision and false positives.** Was it right.
- **Tokens.** The real cost. We expect swarm to stay flatter as scale grows.
- **Quality.** An LLM judge scores the final output against a rubric.
- **Pattern adherence.** Did the agent actually follow the intended workflow.

## Results

<!-- RESULTS:START -->
_No results captured yet. Run the suite, then `npx tsx build-report.ts`._
<!-- RESULTS:END -->

Tokens (the cost axis) come from LangSmith via `analyze.ts` and are tracked separately.

