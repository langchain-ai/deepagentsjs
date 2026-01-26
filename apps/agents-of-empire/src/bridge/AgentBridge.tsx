import { useCallback, useEffect, useRef, createContext, useContext } from "react";
import { v4 as uuidv4 } from "uuid";
import { useGameStore, type GameAgent, type AgentState, type DragonType } from "../store/gameStore";
import type { DeepAgent, DeepAgentTypeConfig } from "deepagents";

// ============================================================================
// Types
// ============================================================================

export interface AgentConfig {
  name?: string;
  model?: string;
  tools?: any[];
  systemPrompt?: string;
}

export interface AgentEvent {
  type: AgentEventType;
  agentId: string;
  timestamp: number;
  data?: any;
}

export type AgentEventType =
  | "agent:created"
  | "agent:thinking"
  | "agent:spoke"
  | "tool:call:start"
  | "tool:call:complete"
  | "tool:call:error"
  | "subagent:spawned"
  | "file:written"
  | "file:read"
  | "error:occurred"
  | "goal:completed"
  | "agent:moving";

// ============================================================================
// Event Mappings
// ============================================================================

const EVENT_TO_STATE: Record<AgentEventType, AgentState> = {
  "agent:created": "IDLE",
  "agent:thinking": "THINKING",
  "agent:spoke": "IDLE",
  "tool:call:start": "WORKING",
  "tool:call:complete": "IDLE",
  "tool:call:error": "ERROR",
  "subagent:spawned": "WORKING",
  "file:written": "COMPLETING",
  "file:read": "WORKING",
  "error:occurred": "ERROR",
  "goal:completed": "COMPLETING",
  "agent:moving": "MOVING",
};

const ERROR_TO_DRAGON_TYPE = (error: string): DragonType => {
  const lower = error.toLowerCase();
  if (lower.includes("syntax") || lower.includes("parse")) return "SYNTAX";
  if (lower.includes("network") || lower.includes("fetch") || lower.includes("connection")) return "NETWORK";
  if (lower.includes("permission") || lower.includes("access") || lower.includes("auth")) return "PERMISSION";
  if (lower.includes("runtime") || lower.includes("execution")) return "RUNTIME";
  return "UNKNOWN";
};

// ============================================================================
// Agent Bridge Hook
// ============================================================================

export function useAgentBridge() {
  const spawnAgent = useGameStore((state) => state.spawnAgent);
  const updateAgent = useGameStore((state) => state.updateAgent);
  const setAgentState = useGameStore((state) => state.setAgentState);
  const setThoughtBubble = useGameStore((state) => state.setThoughtBubble);
  const spawnDragon = useGameStore((state) => state.spawnDragon);
  const removeDragon = useGameStore((state) => state.removeDragon);

  // Spawn a new Deep Agent and create visual representation
  const spawnDeepAgent = useCallback(
    async (config: AgentConfig = {}): Promise<string> => {
      const agentId = uuidv4();
      const name = config.name || `Agent-${agentId.slice(0, 6)}`;

      // Spawn visual agent
      const gameAgent = spawnAgent(name, [25 + Math.random() * 5, 0, 25 + Math.random() * 5]);

      // Store Deep Agent reference (will be set when agent is invoked)
      updateAgent(gameAgent.id, {
        agentRef: {
          id: agentId,
          config,
        },
      });

      return gameAgent.id;
    },
    [spawnAgent, updateAgent]
  );

  // Map agent state to visual state
  const syncVisualState = useCallback(
    (agentId: string, event: AgentEvent) => {
      const targetState = EVENT_TO_STATE[event.type];
      if (targetState) {
        setAgentState(agentId, targetState);
      }

      // Set thought bubble for thinking
      if (event.type === "agent:thinking" && event.data?.thought) {
        setThoughtBubble(agentId, event.data.thought);
      }

      // Clear thought bubble after work completes
      if (event.type === "tool:call:complete" || event.type === "goal:completed") {
        setThoughtBubble(agentId, null);
      }
    },
    [setAgentState, setThoughtBubble]
  );

  // Handle tool call visualization
  const handleToolCall = useCallback(
    (agentId: string, toolName: string, status: "start" | "complete" | "error") => {
      if (status === "start") {
        setThoughtBubble(agentId, `🔧 ${toolName}...`);
      } else if (status === "complete") {
        setThoughtBubble(agentId, `✅ ${toolName} done`);
        setTimeout(() => setThoughtBubble(agentId, null), 2000);
      } else if (status === "error") {
        setThoughtBubble(agentId, `❌ ${toolName} failed`);
      }
    },
    [setThoughtBubble]
  );

  // Handle error -> dragon spawn
  const handleError = useCallback(
    (agentId: string, error: string) => {
      const agent = useGameStore.getState().agents.get(agentId);
      if (!agent) return;

      const dragonType = ERROR_TO_DRAGON_TYPE(error);
      const dragon = spawnDragon(
        dragonType,
        [agent.position[0] + 2, 0, agent.position[2]] as [number, number, number],
        error,
        agentId
      );

      // Set agent to combat state
      setAgentState(agentId, "COMBAT");

      return dragon.id;
    },
    [spawnDragon, setAgentState]
  );

  // Handle subagent spawn
  const handleSubagentSpawn = useCallback(
    (parentAgentId: string, subagentName: string) => {
      const parent = useGameStore.getState().agents.get(parentAgentId);
      if (!parent) return;

      // Spawn subagent visual near parent
      const subagent = spawnAgent(
        subagentName,
        [
          parent.position[0] + (Math.random() - 0.5) * 3,
          0,
          parent.position[2] + (Math.random() - 0.5) * 3,
        ],
        null,
        parentAgentId
      );

      return subagent.id;
    },
    [spawnAgent]
  );

  return {
    spawnDeepAgent,
    syncVisualState,
    handleToolCall,
    handleError,
    handleSubagentSpawn,
  };
}

// ============================================================================
// Deep Agent Stream Processor
// ============================================================================

interface StreamProcessorOptions {
  agentId: string;
  onEvent?: (event: AgentEvent) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
}

export function processAgentStream(
  stream: AsyncIterable<any>,
  options: StreamProcessorOptions
): { cancel: () => void } {
  const { agentId, onEvent, onComplete, onError } = options;
  let cancelled = false;

  const process = async () => {
    try {
      for await (const chunk of stream) {
        if (cancelled) break;

        // Parse chunk and emit events
        if (chunk?.events) {
          for (const event of chunk.events) {
            const agentEvent: AgentEvent = {
              type: event.type || "agent:spoke",
              agentId,
              timestamp: Date.now(),
              data: event.data,
            };
            onEvent?.(agentEvent);
          }
        }

        // Handle LangGraph streaming format
        if (chunk?.[agentId]?.messages) {
          onEvent?.({
            type: "agent:spoke",
            agentId,
            timestamp: Date.now(),
            data: chunk[agentId],
          });
        }
      }
      onComplete?.();
    } catch (error) {
      if (!cancelled) {
        onError?.(error as Error);
      }
    }
  };

  process();

  return {
    cancel: () => {
      cancelled = true;
    },
  };
}

// ============================================================================
// Agent Bridge Component
// ============================================================================

interface AgentBridgeProviderProps {
  children: React.ReactNode;
}

export function AgentBridgeProvider({ children }: AgentBridgeProviderProps) {
  const activeStreams = useRef<Map<string, () => void>>(new Map());
  const bridge = useAgentBridge();

  // Register an agent for streaming
  const registerAgent = useCallback(
    (agentId: string, deepAgent: DeepAgent) => {
      const streamProcessor = deepAgent.stream?.({ messages: [] });
      if (!streamProcessor) return;

      const { cancel } = processAgentStream(streamProcessor as AsyncIterable<any>, {
        agentId,
        onEvent: (event) => {
          bridge.syncVisualState(agentId, event);

          // Handle specific event types
          switch (event.type) {
            case "tool:call:start":
              bridge.handleToolCall(agentId, event.data?.tool || "tool", "start");
              break;
            case "tool:call:complete":
              bridge.handleToolCall(agentId, event.data?.tool || "tool", "complete");
              break;
            case "tool:call:error":
              bridge.handleToolCall(agentId, event.data?.tool || "tool", "error");
              bridge.handleError(agentId, event.data?.error || "Tool call failed");
              break;
            case "error:occurred":
              bridge.handleError(agentId, event.data?.error || "Unknown error");
              break;
            case "subagent:spawned":
              bridge.handleSubagentSpawn(agentId, event.data?.name || "Subagent");
              break;
          }
        },
        onComplete: () => {
          // Stream completed
          console.log(`Agent ${agentId} stream completed`);
        },
        onError: (error) => {
          // Stream error - spawn dragon
          bridge.handleError(agentId, error.message);
        },
      });

      activeStreams.current.set(agentId, cancel);
    },
    [bridge]
  );

  // Unregister an agent
  const unregisterAgent = useCallback((agentId: string) => {
    const cancel = activeStreams.current.get(agentId);
    if (cancel) {
      cancel();
      activeStreams.current.delete(agentId);
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const cancel of activeStreams.current.values()) {
        cancel();
      }
      activeStreams.current.clear();
    };
  }, []);

  return (
    <AgentBridgeContext.Provider value={{ registerAgent, unregisterAgent, bridge }}>
      {children}
    </AgentBridgeContext.Provider>
  );
}

// ============================================================================
// Agent Bridge Context
// ============================================================================

interface AgentBridgeContextValue {
  registerAgent: (agentId: string, deepAgent: DeepAgent) => void;
  unregisterAgent: (agentId: string) => void;
  bridge: ReturnType<typeof useAgentBridge>;
}

const AgentBridgeContext = createContext<AgentBridgeContextValue | null>(null);

export function useAgentBridgeContext() {
  const context = useContext(AgentBridgeContext);
  if (!context) {
    throw new Error("useAgentBridgeContext must be used within AgentBridgeProvider");
  }
  return context;
}

// ============================================================================
// Simulated Agent Events (for testing without real Deep Agent)
// ============================================================================

export function createMockAgentStream(agentId: string): AsyncIterable<AgentEvent> {
  const events: AgentEvent[] = [
    { type: "agent:created", agentId, timestamp: Date.now() },
    { type: "agent:thinking", agentId, timestamp: Date.now() + 100, data: { thought: "🤔 Processing..." } },
    { type: "tool:call:start", agentId, timestamp: Date.now() + 500, data: { tool: "search" } },
    { type: "tool:call:complete", agentId, timestamp: Date.now() + 2000, data: { tool: "search" } },
    { type: "goal:completed", agentId, timestamp: Date.now() + 2500 },
  ];

  return (async function* () {
    for (const event of events) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      yield event;
    }
  })();
}

export function createMockAgentErrorStream(agentId: string, error: string): AsyncIterable<AgentEvent> {
  const events: AgentEvent[] = [
    { type: "agent:created", agentId, timestamp: Date.now() },
    { type: "agent:thinking", agentId, timestamp: Date.now() + 100 },
    { type: "tool:call:start", agentId, timestamp: Date.now() + 500, data: { tool: "code_executor" } },
    { type: "tool:call:error", agentId, timestamp: Date.now() + 1500, data: { tool: "code_executor", error } },
    { type: "error:occurred", agentId, timestamp: Date.now() + 1600, data: { error } },
  ];

  return (async function* () {
    for (const event of events) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      yield event;
    }
  })();
}
