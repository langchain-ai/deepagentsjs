"""
A2A AgentExecutor that wraps the LangGraph researcher graph.

Maps A2A protocol events to LangGraph stream output. The A2A context_id is
used as the LangGraph thread_id so conversation history is preserved across
multi-turn interactions (e.g. HITL responses) within the same A2A context.
"""

from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.tasks import TaskUpdater
from a2a.types import Part, TaskState, TextPart
from a2a.utils import new_task

from .agent import graph


class ResearcherExecutor(AgentExecutor):
    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        query = context.get_user_input()

        task = context.current_task
        if task is None:
            task = new_task(context.message)
            await event_queue.enqueue_event(task)

        updater = TaskUpdater(event_queue, task.id, task.context_id)
        await updater.update_status(TaskState.working, message=None)

        # Use context_id as the LangGraph thread_id to preserve history.
        config = {"configurable": {"thread_id": task.context_id}}
        inputs = {"messages": [("user", query)]}

        result = await graph.ainvoke(inputs, config)
        final_message = result["messages"][-1].content

        await updater.add_artifact(
            parts=[Part(root=TextPart(text=final_message))],
            name="research_result",
        )
        await updater.complete()

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        if context.current_task:
            updater = TaskUpdater(event_queue, context.current_task.id, context.current_task.context_id)
            await updater.update_status(TaskState.canceled)
