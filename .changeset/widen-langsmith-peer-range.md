---
"deepagents": patch
---

chore(deepagents): widen the `langsmith` peer range to `>=0.7.1 <0.10.0`

The upper bound stops below 0.10.0 rather than 1.0.0 because langsmith is pre-1.0 and ships breaking changes in minor bumps, so a new minor should be adopted deliberately instead of pre-authorized.
