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

    // Add base structure at center
    addStructure({
      type: "base",
      position: [25, 0, 25],
      name: "Command Center",
      description: "Agent spawn point and base of operations",
    });

    // Add quest goal structure
    addStructure({
      type: "castle",
      position: [40, 0, 10],
      name: "Knowledge Castle",
      description: "The ultimate goal - complete all research here",
    });

    // Add workshop
    addStructure({
      type: "workshop",
      position: [10, 0, 40],
      name: "Code Workshop",
      description: "Where agents craft their solutions",
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
