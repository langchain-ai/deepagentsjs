import { useRef, useCallback, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Vector3 } from "three";
import { useGameStore, type AgentState } from "../store/gameStore";

// ============================================================================
// Game Configuration
// ============================================================================

export interface GameConfig {
  tickRate?: number; // Updates per second
  autoSave?: boolean;
  debugMode?: boolean;
}

const DEFAULT_CONFIG: GameConfig = {
  tickRate: 60,
  autoSave: false,
  debugMode: false,
};

// ============================================================================
// Game Hook
// ============================================================================()

export function useGame(config: GameConfig = DEFAULT_CONFIG) {
  const { tickRate = 60 } = config;
  const lastTick = useRef(0);
  const tickAccumulator = useRef(0);
  const tickInterval = 1000 / tickRate;

  const agents = useGameStore((state) => state.agents);
  const dragons = useGameStore((state) => state.dragons);
  const updateAgent = useGameStore((state) => state.updateAgent);
  const updateDragon = useGameStore((state) => state.updateDragon);

  // Game tick - runs every frame at tick rate
  useFrame((_, delta) => {
    const now = performance.now();
    tickAccumulator.current += delta * 1000;

    // Process ticks
    while (tickAccumulator.current >= tickInterval) {
      tickAccumulator.current -= tickInterval;
      gameTick(now);
    }
  });

  // Single game tick
  const gameTick = useCallback((now: number) => {
    // Update agent positions
    for (const [id, agent] of agents) {
      if (agent.targetPosition) {
        moveAgentTowardsTarget(agent, now);
      }

      // Update agent state timers
      updateAgentState(agent, now);
    }

    // Update dragon AI
    for (const [id, dragon] of dragons) {
      updateDragonAI(dragon, now);
    }
  }, [agents, dragons]);

  // Move agent towards target
  const moveAgentTowardsTarget = useCallback((agent: any, now: number) => {
    const speed = 5; // units per second
    const current = new Vector3(...agent.position);
    const target = new Vector3(...agent.targetPosition);

    const direction = target.clone().sub(current);
    const distance = direction.length();

    if (distance < 0.1) {
      // Arrived
      useGameStore.getState().updateAgent(agent.id, {
        position: [target.x, target.y, target.z],
        targetPosition: null,
        state: agent.currentTask ? "WORKING" : "IDLE",
      });
      return;
    }

    const moveDist = speed / (1000 / (performance.now() - (agent.lastMove || now)));
    direction.normalize().multiplyScalar(Math.min(moveDist, distance));

    const newPos = current.add(direction);
    useGameStore.getState().setAgentPosition(agent.id, [newPos.x, newPos.y, newPos.z]);
    useGameStore.getState().updateAgent(agent.id, { lastMove: now });
  }, []);

  // Update agent state based on current state
  const updateAgentState = useCallback((agent: any, now: number) => {
    switch (agent.state) {
      case "THINKING":
        // Simulate thinking duration
        if (!agent.thinkStart) {
          useGameStore.getState().updateAgent(agent.id, { thinkStart: now });
        } else if (now - agent.thinkStart > 2000) {
          // Done thinking
          useGameStore.getState().updateAgent(agent.id, {
            state: "IDLE",
            thinkStart: null,
          });
        }
        break;

      case "WORKING":
        // Simulate work duration
        if (!agent.workStart) {
          useGameStore.getState().updateAgent(agent.id, { workStart: now });
        } else if (now - agent.workStart > 3000) {
          // Done working
          useGameStore.getState().updateAgent(agent.id, {
            state: "COMPLETING",
            workStart: null,
          });
        }
        break;

      case "COMPLETING":
        // Show completion for a moment then go idle
        if (!agent.completeStart) {
          useGameStore.getState().updateAgent(agent.id, { completeStart: now });
        } else if (now - agent.completeStart > 1500) {
          useGameStore.getState().updateAgent(agent.id, {
            state: "IDLE",
            completeStart: null,
            currentTask: "Awaiting orders...",
          });
        }
        break;

      case "ERROR":
        // Stay in error state until player intervenes
        break;

      case "COMBAT":
        // Combat is handled by combat system
        break;
    }
  }, []);

  // Update dragon AI
  const updateDragonAI = useCallback((dragon: any, now: number) => {
    // Simple AI: move toward target agent if exists
    if (dragon.targetAgentId) {
      const agent = useGameStore.getState().agents.get(dragon.targetAgentId);
      if (agent) {
        const dragonPos = new Vector3(...dragon.position);
        const agentPos = new Vector3(...agent.position);
        const direction = agentPos.sub(dragonPos).normalize();
        const speed = 1; // Dragons move slower

        // Move dragon closer
        const newPos = dragonPos.add(direction.multiplyScalar(speed * 0.016));
        useGameStore.getState().updateDragon(dragon.id, {
          position: [newPos.x, newPos.y, newPos.z],
        });

        // Attack if in range
        if (dragonPos.distanceTo(agentPos) < 2) {
          // Dragon attacks!
          const damage = 5 + Math.floor(Math.random() * 10);
          useGameStore.getState().updateAgent(dragon.targetAgentId, {
            health: Math.max(0, agent.health - damage),
          });
        }
      }
    }
  }, []);

  return {
    lastTick,
  };
}

// ============================================================================
// Game Timer Hook
// ============================================================================()

export function useGameTime() {
  const [gameTime, setGameTime] = useState(0);
  const startTime = useRef(performance.now());

  useFrame(() => {
    setGameTime(performance.now() - startTime.current);
  });

  // Format time as MM:SS
  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  return {
    gameTime,
    formattedTime: formatTime(gameTime),
  };
}

// ============================================================================
// Game Stats Hook
// ============================================================================()

export function useGameStats() {
  const agents = useGameStore((state) => Array.from(state.agents.values()));
  const dragons = useGameStore((state) => Array.from(state.dragons.values()));
  const quests = useGameStore((state) => Array.from(state.quests.values()));

  const stats = {
    totalAgents: agents.length,
    activeAgents: agents.filter((a) => a.state !== "IDLE").length,
    idleAgents: agents.filter((a) => a.state === "IDLE").length,
    totalDragons: dragons.length,
    activeQuests: quests.filter((q) => q.status === "in_progress").length,
    completedQuests: quests.filter((q) => q.status === "completed").length,
    averageLevel: agents.length > 0
      ? agents.reduce((sum, a) => sum + a.level, 0) / agents.length
      : 0,
  };

  return stats;
}
