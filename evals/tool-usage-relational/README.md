# tool-usage-relational

Evaluates multi-step tool chaining over relational data (users, locations, foods connected by IDs). Ported from the Python deepagents eval `test_tool_usage_relational.py`. Tests sequential lookups (1→4 hops) and parallel fan-out where independent tool calls should fire in the same step.
