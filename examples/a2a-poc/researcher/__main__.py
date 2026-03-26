"""
A2A server entry point.

Run with:
    python -m researcher
"""

import uvicorn
from a2a.server.apps import A2AStarletteApplication
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import (
    AgentCapabilities,
    AgentCard,
    AgentSkill,
)

from .agent_executor import ResearcherExecutor

PORT = 10000

agent_card = AgentCard(
    name="researcher",
    description="A research agent that investigates topics and produces concise summaries.",
    url=f"http://localhost:{PORT}/",
    version="0.0.1",
    capabilities=AgentCapabilities(streaming=False),
    skills=[
        AgentSkill(
            id="research",
            name="Research",
            description="Investigate a topic using web search and produce a research summary.",
            tags=["research", "web-search"],
            examples=["Research the history of the internet"],
        )
    ],
    default_input_modes=["text/plain"],
    default_output_modes=["text/plain"],
)

handler = DefaultRequestHandler(
    agent_executor=ResearcherExecutor(),
    task_store=InMemoryTaskStore(),
)

app = A2AStarletteApplication(agent_card=agent_card, http_handler=handler).build()

if __name__ == "__main__":
    print(f"Starting A2A researcher server on http://localhost:{PORT}")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
