import React, { useEffect, useState } from "react";
import { useGameStore } from "../store/gameStore";
import type { GameConfig } from "./GameHooks";
import { useGame } from "./GameHooks";

// ============================================================================
// Game State Component
// ============================================================================()

interface GameStateProps {
  children: React.ReactNode;
  config?: GameConfig;
}

export function GameState({ children, config }: GameStateProps) {
  const [isInitialized, setIsInitialized] = useState(false);

  // Initialize game world
  useEffect(() => {
    const { initializeWorld, addStructure } = useGameStore.getState();

    // Initialize terrain
    initializeWorld(50, 50);

    // ============================================================================
    // Initialize Goal Structures - All 5 Types
    // ============================================================================

    // 1. BASE - Home base (fortified)
    addStructure({
      type: "base",
      position: [25, 0, 25],
      name: "Command Center",
      description: "Agent spawn point and base of operations",
    });

    // 2. CASTLE - Main goals (large, impressive)
    addStructure({
      type: "castle",
      position: [40, 0, 10],
      name: "Knowledge Castle",
      description: "The ultimate goal - complete all research here",
      goalId: "main-goal-knowledge",
    });

    // 3. TOWER - Sub-goals (tall, watchtower style)
    addStructure({
      type: "tower",
      position: [8, 0, 8],
      name: "Scout Tower",
      description: "Sub-goal: Establish reconnaissance",
      goalId: "sub-goal-scouting",
    });

    addStructure({
      type: "tower",
      position: [42, 0, 42],
      name: "Watchtower",
      description: "Sub-goal: Defend the perimeter",
      goalId: "sub-goal-defense",
    });

    // 4. WORKSHOP - Tasks (building with work areas)
    addStructure({
      type: "workshop",
      position: [10, 0, 40],
      name: "Code Workshop",
      description: "Task: Craft agent solutions",
    });

    addStructure({
      type: "workshop",
      position: [40, 0, 40],
      name: "Research Lab",
      description: "Task: Analyze data patterns",
    });

    // 5. CAMPFIRE - Gathering points (warm, inviting)
    addStructure({
      type: "campfire",
      position: [25, 0, 15],
      name: "Strategy Circle",
      description: "Gathering point for agent coordination",
    });

    addStructure({
      type: "campfire",
      position: [15, 0, 25],
      name: "Rest Camp",
      description: "Agent rest and recovery point",
    });

    setIsInitialized(true);
  }, []);

  // Set up game loop
  useGame(config);

  if (!isInitialized) {
    return (
      <div className="fixed inset-0 bg-gray-900 flex items-center justify-center text-empire-gold">
        <div className="text-center">
          <div className="text-4xl mb-4">⚔️</div>
          <div className="text-xl">Loading Agents of Empire...</div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

// Re-export hooks from GameHooks
export { useGame, useGameTime, useGameStats } from "./GameHooks";
export type { GameConfig };
