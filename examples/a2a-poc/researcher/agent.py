"""
Research agent graph.

Uses LangGraph's create_react_agent with a stub web search tool and an
in-memory checkpointer so conversation history is preserved across A2A
multi-turn interactions within the same context.
"""

import os
from langchain_anthropic import ChatAnthropic
from langchain_community.tools.tavily_search import TavilySearchResults
from langgraph.prebuilt import create_react_agent
from langgraph.checkpoint.memory import MemorySaver


search = TavilySearchResults(max_results=5)

memory = MemorySaver()

model = ChatAnthropic(model=os.environ.get("MODEL", "claude-haiku-4-5-20251001"))

graph = create_react_agent(
    model,
    tools=[search],
    checkpointer=memory,
    prompt=(
        "You are a thorough research agent. Investigate the given topic using "
        "web search, synthesize the findings, and produce a concise research summary "
        "(200-400 words). Make at least 2 searches to cover the topic from different angles."
    ),
)
