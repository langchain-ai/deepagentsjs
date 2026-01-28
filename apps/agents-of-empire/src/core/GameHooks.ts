import { useRef, useCallback, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Vector3 } from "three";
import { useGameStore, useAgentsShallow, useDragonsShallow, useQuestsShallow, useTilesShallow, type AgentState, type GameAgent, type Dragon, type Quest } from "../store/gameStore";
import { findPath } from "../world/WorldManager";

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
// State Duration Constants (in milliseconds)
// ============================================================================

const STATE_DURATIONS = {
  THINKING: 2000,  // 2 seconds
  WORKING: 3000,  // 3 seconds
  COMPLETING: 1500, // 1.5 seconds
} as const;

// ============================================================================
// Game Hook
// ============================================================================()

export function useGame(config: GameConfig = DEFAULT_CONFIG) {
  const { tickRate = 60 } = config;
  const lastTick = useRef(0);
  const tickAccumulator = useRef(0);
  const tickInterval = 1000 / tickRate;
  const tiles = useTilesShallow() as Record<string, { walkable: boolean }>;
  const worldSize = useGameStore((state) => state.worldSize);

  // Don't subscribe to agents/dragons - use getState() in useFrame instead
  // This prevents infinite re-renders inside Canvas
  const updateAgent = useGameStore((state) => state.updateAgent);
  const updateDragon = useGameStore((state) => state.updateDragon);

  // Move agent towards target using pathfinding
  const moveAgentTowardsTarget = useCallback((agent: GameAgent, now: number, delta: number) => {
    const speed = 5; // units per second
    const current = new Vector3(...agent.position);
    const target = new Vector3(...agent.targetPosition);
    const store = useGameStore.getState();

    // Check if we need to compute a new path
    if (!agent.currentPath && agent.targetPosition) {
      const startX = Math.floor(current.x);
      const startZ = Math.floor(current.z);
      const endX = Math.floor(target.x);
      const endZ = Math.floor(target.z);

      // Compute A* path
      const path = findPath(startX, startZ, endX, endZ, tiles, worldSize.width, worldSize.height);

      if (path && path.length > 0) {
        // Path found - set it on the agent
        setAgentPath(agent.id, path);
      } else {
        // No path found - move directly (fallback behavior)
        const direction = target.clone().sub(current);
        const distance = direction.length();

        if (distance < 0.1) {
          store.updateAgent(agent.id, {
            position: [target.x, target.y, target.z],
            targetPosition: null,
            currentPath: null,
            state: agent.currentTask ? "WORKING" : "IDLE",
          });
          return;
        }

        // Use actual delta time instead of hard-coded 0.016
        const moveDist = speed * delta;
        direction.normalize().multiplyScalar(Math.min(moveDist, distance));

        const newPos = current.add(direction);
        store.setAgentPosition(agent.id, [newPos.x, newPos.y, newPos.z]);
        store.updateAgent(agent.id, { lastMove: now });
        return;
      }
    }

    // Follow the computed path
    if (agent.currentPath && agent.pathIndex < agent.currentPath.length) {
      const nextTile = agent.currentPath[agent.pathIndex];
      const nextPos = new Vector3(nextTile[0] + 0.5, 0, nextTile[1] + 0.5);
      const direction = nextPos.sub(current);
      const distance = direction.length();

      if (distance < 0.2) {
        // Reached this waypoint, move to next
        store.updateAgent(agent.id, { pathIndex: agent.pathIndex + 1 });

        // Check if we've reached the final destination
        if (agent.pathIndex + 1 >= agent.currentPath.length) {
          const finalTarget = new Vector3(...agent.targetPosition);
          store.updateAgent(agent.id, {
            position: [finalTarget.x, finalTarget.y, finalTarget.z],
            targetPosition: null,
            currentPath: null,
            pathIndex: 0,
            state: agent.currentTask ? "WORKING" : "IDLE",
          });
        }
      } else {
        // Move towards next waypoint
        // Use actual delta time instead of hard-coded 0.016
        const moveDist = speed * delta;
        direction.normalize().multiplyScalar(Math.min(moveDist, distance));

        const newPos = current.add(direction);
        store.setAgentPosition(agent.id, [newPos.x, newPos.y, newPos.z]);
        store.updateAgent(agent.id, { lastMove: now });
      }
    }
  }, [tiles, worldSize, setAgentPath]);

  // Update agent state based on current state
  const updateAgentState = useCallback((agent: GameAgent, now: number) => {
    switch (agent.state) {
      case "THINKING":
        // Simulate thinking duration
        if (!agent.thinkStart) {
          useGameStore.getState().updateAgent(agent.id, { thinkStart: now });
        } else if (now - agent.thinkStart > STATE_DURATIONS.THINKING) {
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
        } else if (now - agent.workStart > STATE_DURATIONS.WORKING) {
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
        } else if (now - agent.completeStart > STATE_DURATIONS.COMPLETING) {
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

      case "IDLE":
        break;

      case "COMBAT":
        // Combat is handled by combat system
        break;
    }
  }, []);

  // Update dragon AI
  const updateDragonAI = useCallback((dragon: Dragon, _now: number, delta: number) => {
    // Simple AI: move toward target agent if exists
    if (dragon.targetAgentId) {
      const agent = useGameStore.getState().agents[dragon.targetAgentId];
      if (agent) {
        const dragonPos = new Vector3(...dragon.position);
        const agentPos = new Vector3(...agent.position);
        const direction = agentPos.sub(dragonPos).normalize();
        const speed = 1; // Dragons move slower

        // Move dragon closer using actual delta time instead of hard-coded 0.016
        const newPos = dragonPos.add(direction.multiplyScalar(speed * delta));
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

  // Game tick - runs every frame at tick rate
  useFrame((_, delta) => {
    const now = performance.now();
    tickAccumulator.current += delta * 1000;

    // Process ticks
    while (tickAccumulator.current >= tickInterval) {
      tickAccumulator.current -= tickInterval;
      gameTick(now, delta);
    }
  });

  // Single game tick
  const gameTick = useCallback((now: number, delta: number) => {
    // Use getState() to get current values without subscribing
    const agents = useGameStore.getState().agents;
    const dragons = useGameStore.getState().dragons;

    // Update agent positions
    for (const id in agents) {
      const agent = agents[id];
      if (agent.targetPosition) {
        moveAgentTowardsTarget(agent, now, delta);
      }

      // Update agent state timers
      updateAgentState(agent, now);
    }

    // Update dragon AI
    for (const id in dragons) {
      const dragon = dragons[id];
      updateDragonAI(dragon, now, delta);
    }
  }, [moveAgentTowardsTarget, updateDragonAI, updateAgentState]);

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
  const agents = useAgentsShallow() as Record<string, GameAgent>;
  const dragons = useDragonsShallow() as Record<string, Dragon>;
  const quests = useQuestsShallow() as Record<string, Quest>;

  const stats = {
    totalAgents: Object.keys(agents).length,
    activeAgents: Object.values(agents).filter((a) => a.state !== "IDLE").length,
    idleAgents: Object.values(agents).filter((a) => a.state === "IDLE").length,
    totalDragons: Object.keys(dragons).length,
    activeQuests: Object.values(quests).filter((q) => q.status === "in_progress").length,
    completedQuests: Object.values(quests).filter((q) => q.status === "completed").length,
    averageLevel: Object.keys(agents).length > 0
      ? Object.values(agents).reduce((sum: number, a: GameAgent) => sum + a.level, 0) / Object.keys(agents).length
      : 0,
  };

  return stats;
}
