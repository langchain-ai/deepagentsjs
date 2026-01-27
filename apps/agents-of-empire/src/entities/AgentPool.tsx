import { useState, useCallback, useEffect, useRef } from "react";
import { useGameStore, type GameAgent } from "../store/gameStore";

// ============================================================================
// Agent Pool Manager
// ============================================================================

interface AgentPoolOptions {
  maxAgents?: number;
  spawnRadius?: number;
  spawnPattern?: "random" | "grid" | "circle";
}

const DEFAULT_AGENTS = [
  { name: "Sir Query", role: "Researcher", color: "#3498db" },
  { name: "Lady Parser", role: "Analyst", color: "#9b59b6" },
  { name: "Knight Coder", role: "Developer", color: "#2ecc71" },
  { name: "Scribe Writer", role: "Writer", color: "#f39c12" },
  { name: "Wizard Debug", role: "Debugger", color: "#e74c3c" },
];

export function useAgentPool(options: AgentPoolOptions = {}) {
  const { maxAgents = 500, spawnRadius = 20, spawnPattern = "random" } = options;

  const spawnAgent = useCallback(
    (name?: string, position?: [number, number, number], agentRef?: any, parentId?: string) => {
      const agentName = name || DEFAULT_AGENTS[Math.floor(Math.random() * DEFAULT_AGENTS.length)].name;
      let spawnPos: [number, number, number];

      if (position) {
        spawnPos = position;
      } else {
        spawnPos = [
          25 + (Math.random() - 0.5) * spawnRadius * 2,
          0,
          25 + (Math.random() - 0.5) * spawnRadius * 2,
        ];
      }

      return useGameStore.getState().spawnAgent(agentName, spawnPos, agentRef, parentId);
    },
    [spawnRadius]
  );

  const spawnAgentBatch = useCallback(
    (count: number, basePosition?: [number, number, number], pattern?: "random" | "grid" | "circle") => {
      const agents: GameAgent[] = [];
      const base = basePosition || [25, 0, 25];
      const spawnPattern = pattern || "random";

      if (spawnPattern === "grid") {
        // Grid pattern for organized deployment
        const gridSize = Math.ceil(Math.sqrt(count));
        const spacing = 2;
        const offset = (gridSize * spacing) / 2;

        for (let i = 0; i < count; i++) {
          const row = Math.floor(i / gridSize);
          const col = i % gridSize;
          const pos: [number, number, number] = [
            base[0] + col * spacing - offset,
            base[1],
            base[2] + row * spacing - offset,
          ];
          agents.push(spawnAgent(undefined, pos));
        }
      } else if (spawnPattern === "circle") {
        // Circle pattern for defensive formation
        for (let i = 0; i < count; i++) {
          const angle = (i / count) * Math.PI * 2;
          const radius = spawnRadius;
          const pos: [number, number, number] = [
            base[0] + Math.cos(angle) * radius,
            base[1],
            base[2] + Math.sin(angle) * radius,
          ];
          agents.push(spawnAgent(undefined, pos));
        }
      } else {
        // Random pattern (default)
        for (let i = 0; i < count; i++) {
          const pos: [number, number, number] = [
            base[0] + (Math.random() - 0.5) * spawnRadius * 2,
            base[1],
            base[2] + (Math.random() - 0.5) * spawnRadius * 2,
          ];
          agents.push(spawnAgent(undefined, pos));
        }
      }

      return agents;
    },
    [spawnRadius, spawnAgent]
  );

  const despawnAgent = useCallback((id: string) => {
    useGameStore.getState().removeAgent(id);
  }, []);

  const despawnAllAgents = useCallback(() => {
    const { agents } = useGameStore.getState();
    for (const [id] of agents) {
      despawnAgent(id);
    }
  }, [despawnAgent]);

  return {
    spawnAgent,
    spawnAgentBatch,
    despawnAgent,
    despawnAllAgents,
  };
}

// ============================================================================
// Initial Agent Spawn Component
// ============================================================================

interface InitialAgentsProps {
  count?: number;
}

export function InitialAgents({ count = 100 }: InitialAgentsProps) {
  const agentCount = useGameStore((state) => state.agentCount);
  const hasInitialized = useRef(false);

  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;

    // Spawn initial agents in grid pattern for better distribution
    const { spawnAgentBatch } = useGameStore.getState();
    const newAgents = spawnAgentBatch?.(count, [25, 0, 25], "grid");

    // Add default tools to agents
    const defaultTools = [
      { id: "search", name: "Search", type: "search" as const, icon: "🔍", description: "Search the web" },
      { id: "read", name: "File Reader", type: "file_reader" as const, icon: "📜", description: "Read files" },
      { id: "code", name: "Code Executor", type: "code_executor" as const, icon: "🔨", description: "Execute code" },
    ];

    newAgents?.forEach((agent: GameAgent) => {
      useGameStore.getState().updateAgent(agent.id, {
        inventory: [...defaultTools],
        equippedTool: defaultTools[Math.floor(Math.random() * defaultTools.length)],
      });
    });
  }, [count]);

  return null;
}

// ============================================================================
// Agent Spawner Panel Component
// ============================================================================

interface AgentSpawnerProps {
  onSpawn?: (agent: GameAgent) => void;
}

export function AgentSpawner({ onSpawn }: AgentSpawnerProps) {
  const { spawnAgent } = useAgentPool();
  const [selectedType, setSelectedType] = useState(0);

  const handleSpawn = () => {
    const agent = spawnAgent(DEFAULT_AGENTS[selectedType].name);
    onSpawn?.(agent);
  };

  return (
    <div className="absolute top-4 left-4 bg-gray-900/90 border border-empire-gold rounded-lg p-4 text-white">
      <h3 className="text-empire-gold text-lg mb-3">Recruit Agents</h3>

      <div className="space-y-2 mb-4">
        {DEFAULT_AGENTS.map((agent, index) => (
          <button
            key={agent.name}
            onClick={() => setSelectedType(index)}
            className={`w-full text-left px-3 py-2 rounded transition-colors ${
              selectedType === index
                ? "bg-empire-gold text-gray-900"
                : "bg-gray-800 hover:bg-gray-700"
            }`}
          >
            <div className="font-semibold">{agent.name}</div>
            <div className="text-sm opacity-75">{agent.role}</div>
          </button>
        ))}
      </div>

      <button
        onClick={handleSpawn}
        className="w-full bg-empire-green hover:bg-green-600 text-white font-bold py-2 px-4 rounded transition-colors"
      >
        Spawn Agent
      </button>
    </div>
  );
}

import React from "react";
