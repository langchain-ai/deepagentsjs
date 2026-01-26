import React, { useState, useCallback, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { shallow } from "zustand/shallow";
import { useGameStore, useSelectedAgentIds, useAgentsMap, useAgentsShallow, useQuestsShallow, useSelection, useAgentCount, useDragonCount, useQuestCount, useCompletedQuestCount, type GameAgent } from "../store/gameStore";
import { useAgentBridgeContext } from "../bridge/AgentBridge";
import { useCombat } from "../entities/Dragon";

// ============================================================================
// Minimap Component
// ============================================================================

interface MinimapProps {
  width?: number;
  height?: number;
}

export function Minimap({ width = 200, height = 200 }: MinimapProps) {
  const agentsMap = useAgentsShallow();
  const dragonsMap = useGameStore((state) => state.dragons, shallow);
  const structuresMap = useGameStore((state) => state.structures, shallow);
  const selectedAgentIds = useSelection();
  const worldSize = useGameStore((state) => state.worldSize);

  // Convert Records to arrays with useMemo to prevent infinite re-renders
  const agents = useMemo(() => Object.values(agentsMap), [agentsMap]);
  const dragons = useMemo(() => Object.values(dragonsMap), [dragonsMap]);
  const structures = useMemo(() => Object.values(structuresMap), [structuresMap]);

  const scale = width / worldSize.width;

  return (
    <motion.div
      initial={{ opacity: 0, x: 50 }}
      animate={{ opacity: 1, x: 0 }}
      className="absolute top-4 right-4 bg-gray-900/95 border border-empire-gold rounded-lg overflow-hidden"
      style={{ width, height }}
    >
      <svg width={width} height={height} className="w-full h-full">
        {/* Background */}
        <rect width={width} height={height} fill="#1a1a2e" />

        {/* Structures */}
        {structures.map((structure) => (
          <g key={structure.id}>
            <circle
              cx={structure.position[0] * scale}
              cy={structure.position[2] * scale}
              r={4}
              fill="#f39c12"
              opacity={0.6}
            />
          </g>
        ))}

        {/* Dragons */}
        {dragons.map((dragon) => (
          <g key={dragon.id}>
            <circle
              cx={dragon.position[0] * scale}
              cy={dragon.position[2] * scale}
              r={3}
              fill="#e74c3c"
            />
          </g>
        ))}

        {/* Agents */}
        {agents.map((agent) => (
          <g key={agent.id}>
            <circle
              cx={agent.position[0] * scale}
              cy={agent.position[2] * scale}
              r={selectedAgentIds.has(agent.id) ? 4 : 2}
              fill={selectedAgentIds.has(agent.id) ? "#f4d03f" : "#3498db"}
            />
          </g>
        ))}

        {/* Camera view indicator */}
        <rect
          x={0}
          y={0}
          width={width * 0.3}
          height={height * 0.3}
          fill="none"
          stroke="#ffffff"
          strokeWidth={1}
          opacity={0.3}
        />
      </svg>

      <div className="absolute bottom-1 right-2 text-xs text-empire-gold font-bold">
        MAP
      </div>
    </motion.div>
  );
}

// ============================================================================
// Agent Panel Component
// ============================================================================

interface AgentPanelProps {
  className?: string;
}

export function AgentPanel({ className = "" }: AgentPanelProps) {
  const selectedAgentIds = useSelectedAgentIds();
  const agentsMap = useAgentsMap();
  const updateAgent = useGameStore((state) => state.updateAgent);
  const clearSelection = useGameStore((state) => state.clearSelection);

  // Convert Set and Record to array with memoization
  const selectedAgents = useMemo(() => {
    const agents: GameAgent[] = [];
    for (const id of selectedAgentIds) {
      const agent = agentsMap[id];
      if (agent) agents.push(agent);
    }
    return agents;
  }, [selectedAgentIds, agentsMap]);

  if (selectedAgents.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 50 }}
        animate={{ opacity: 1, y: 0 }}
        className={`absolute bottom-4 left-4 bg-gray-900/95 border border-empire-gold rounded-lg p-4 text-white w-80 ${className}`}
      >
        <div className="text-center text-gray-400">
          <p className="text-lg">No agents selected</p>
          <p className="text-sm">Click on agents or drag to select multiple</p>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 50 }}
      animate={{ opacity: 1, y: 0 }}
      className={`absolute bottom-4 left-4 bg-gray-900/95 border border-empire-gold rounded-lg p-4 text-white w-80 max-h-96 overflow-y-auto ${className}`}
    >
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-empire-gold text-lg font-bold">
          {selectedAgents.length} Agent{selectedAgents.length > 1 ? "s" : ""} Selected
        </h3>
        <button
          onClick={clearSelection}
          className="text-gray-400 hover:text-white text-sm"
        >
          Clear
        </button>
      </div>

      <div className="space-y-3">
        {selectedAgents.map((agent) => (
          <div key={agent.id} className="bg-gray-800 rounded p-3 border border-gray-700">
            <div className="flex justify-between items-start mb-2">
              <div>
                <div className="font-semibold text-empire-gold">{agent.name}</div>
                <div className="text-xs text-gray-400">Level {agent.level}</div>
              </div>
              <div className="text-xs px-2 py-1 rounded bg-gray-700">
                {agent.state}
              </div>
            </div>

            {/* Health bar */}
            <div className="mb-2">
              <div className="flex justify-between text-xs mb-1">
                <span>Health</span>
                <span>{agent.health}/{agent.maxHealth}</span>
              </div>
              <div className="h-2 bg-gray-700 rounded overflow-hidden">
                <div
                  className="h-full transition-all"
                  style={{
                    width: `${(agent.health / agent.maxHealth) * 100}%`,
                    backgroundColor: agent.health > 30 ? "#27ae60" : "#e74c3c",
                  }}
                />
              </div>
            </div>

            {/* Current task */}
            {agent.currentTask && (
              <div className="text-xs text-gray-300 mb-2">
                <span className="text-gray-500">Task:</span> {agent.currentTask}
              </div>
            )}

            {/* Equipped tool */}
            <div className="flex items-center justify-between">
              <div className="text-sm">
                {agent.equippedTool ? (
                  <span className="text-empire-gold">
                    {agent.equippedTool.icon} {agent.equippedTool.name}
                  </span>
                ) : (
                  <span className="text-gray-500">No tool equipped</span>
                )}
              </div>
              {agent.equippedTool && (
                <button
                  onClick={() => updateAgent(agent.id, { equippedTool: null })}
                  className="text-xs text-gray-400 hover:text-white"
                >
                  Unequip
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

// ============================================================================
// Inventory Panel Component
// ============================================================================

interface InventoryPanelProps {
  agentId: string;
  onClose?: () => void;
}

export function InventoryPanel({ agentId, onClose }: InventoryPanelProps) {
  const agent = useGameStore((state) => state.agents[agentId]);
  const equipTool = useGameStore((state) => state.equipTool);
  const unequipTool = useGameStore((state) => state.unequipTool);

  if (!agent) return null;

  return (
    <motion.div
      initial={{ opacity: 0, x: -50 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -50 }}
      className="absolute top-1/2 right-4 transform -translate-y-1/2 bg-gray-900/95 border border-empire-gold rounded-lg p-4 text-white w-64"
    >
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-empire-gold text-lg font-bold">Inventory</h3>
        {onClose && (
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            ✕
          </button>
        )}
      </div>

      <div className="mb-4">
        <p className="text-sm text-gray-400 mb-2">{agent.name}'s Tools:</p>
        <div className="space-y-2">
          {agent.inventory.length === 0 ? (
            <p className="text-gray-500 text-sm">No tools available</p>
          ) : (
            agent.inventory.map((tool) => (
              <div
                key={tool.id}
                className={`p-2 rounded border cursor-pointer transition-colors ${
                  agent.equippedTool?.id === tool.id
                    ? "bg-empire-gold text-gray-900 border-empire-gold"
                    : "bg-gray-800 border-gray-700 hover:border-gray-500"
                }`}
                onClick={() =>
                  agent.equippedTool?.id === tool.id
                    ? unequipTool(agentId)
                    : equipTool(agentId, tool)
                }
              >
                <div className="flex items-center gap-2">
                  <span className="text-xl">{tool.icon}</span>
                  <div>
                    <div className="font-semibold text-sm">{tool.name}</div>
                    <div className="text-xs opacity-75">{tool.description}</div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Tool Types Legend */}
      <div className="border-t border-gray-700 pt-3">
        <p className="text-xs text-gray-500 mb-2">Available Tool Types:</p>
        <div className="grid grid-cols-2 gap-1 text-xs">
          <div>🔍 Search</div>
          <div>🔨 Code Executor</div>
          <div>📜 File Reader</div>
          <div>🌐 Web Fetcher</div>
        </div>
      </div>
    </motion.div>
  );
}

// ============================================================================
// Quest Tracker Component
// ============================================================================

interface QuestTrackerProps {
  className?: string;
}

export function QuestTracker({ className = "" }: QuestTrackerProps) {
  const questsMap = useQuestsShallow();
  const assignQuestToAgents = useGameStore((state) => state.assignQuestToAgents);
  const selectedAgentIds = useSelection();

  // Convert Record to array with useMemo to prevent infinite re-renders
  const quests = useMemo(() => Object.values(questsMap), [questsMap]);

  return (
    <motion.div
      initial={{ opacity: 0, x: -50 }}
      animate={{ opacity: 1, x: 0 }}
      className={`absolute top-4 left-4 bg-gray-900/95 border border-empire-gold rounded-lg p-4 text-white w-80 ${className}`}
    >
      <h3 className="text-empire-gold text-lg font-bold mb-3">Quests</h3>

      {quests.length === 0 ? (
        <p className="text-gray-400 text-sm">No active quests</p>
      ) : (
        <div className="space-y-2 max-h-60 overflow-y-auto">
          {quests.map((quest) => (
            <div
              key={quest.id}
              className={`p-3 rounded border ${
                quest.status === "completed"
                  ? "bg-green-900/30 border-green-700"
                  : quest.status === "in_progress"
                  ? "bg-yellow-900/30 border-yellow-700"
                  : "bg-gray-800 border-gray-700"
              }`}
            >
              <div className="flex justify-between items-start mb-1">
                <span className="font-semibold text-sm">{quest.title}</span>
                <span className={`text-xs px-2 py-0.5 rounded ${
                  quest.status === "completed"
                    ? "bg-green-700"
                    : quest.status === "in_progress"
                    ? "bg-yellow-700"
                    : "bg-gray-600"
                }`}>
                  {quest.status}
                </span>
              </div>
              <p className="text-xs text-gray-300 mb-2">{quest.description}</p>

              {quest.status === "pending" && selectedAgentIds.size > 0 && (
                <button
                  onClick={() => assignQuestToAgents(quest.id, Array.from(selectedAgentIds))}
                  className="text-xs bg-empire-gold text-gray-900 px-2 py-1 rounded font-semibold hover:bg-yellow-500"
                >
                  Assign ({selectedAgentIds.size})
                </button>
              )}

              {quest.status === "in_progress" && (
                <div className="text-xs text-gray-400">
                  {quest.assignedAgentIds.length} agent(s) assigned
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}

// ============================================================================
// Context Menu Component
// ============================================================================

interface ContextMenuProps {
  agentId: string;
  position: { x: number; y: number };
  onClose: () => void;
}

export function ContextMenu({ agentId, position, onClose }: ContextMenuProps) {
  const agent = useGameStore((state) => state.agents[agentId]);
  const closeContextMenu = useGameStore((state) => state.closeContextMenu);
  const contextMenuOpen = useGameStore((state) => state.contextMenuOpen);
  const dragonsMap = useGameStore((state) => state.dragons, shallow);
  const [showInventory, setShowInventory] = useState(false);
  const [showCombat, setShowCombat] = useState(false);
  const { attackDragon, autoResolveCombat } = useCombat();

  if (!agent) return null;

  // Find nearby dragons with memoization
  const dragons = useMemo(() => {
    return Object.values(dragonsMap).filter(
      (dragon) =>
        Math.abs(dragon.position[0] - agent.position[0]) < 5 &&
        Math.abs(dragon.position[2] - agent.position[2]) < 5
    );
  }, [dragonsMap, agent.position]);

  const handleAttack = (dragonId: string) => {
    closeContextMenu();
    attackDragon(agentId, dragonId);
  };

  const handleAutoCombat = (dragonId: string) => {
    closeContextMenu();
    autoResolveCombat(agentId, dragonId);
  };

  return (
    <>
      <AnimatePresence>
        {showInventory && (
          <InventoryPanel agentId={agentId} onClose={() => setShowInventory(false)} />
        )}
      </AnimatePresence>

      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        className="fixed bg-gray-900/95 border border-empire-gold rounded-lg py-2 text-white w-56 z-50"
        style={{
          left: Math.min(position.x, window.innerWidth - 230),
          top: Math.min(position.y, window.innerHeight - 300),
        }}
      >
        <div className="px-4 py-2 border-b border-gray-700">
          <div className="font-bold text-empire-gold">{agent.name}</div>
          <div className="text-xs text-gray-400">Level {agent.level} • {agent.state}</div>
        </div>

        <div className="py-1">
          <button
            onClick={() => setShowInventory(true)}
            className="w-full text-left px-4 py-2 hover:bg-gray-800 flex items-center gap-2"
          >
            <span>🎒</span> Open Inventory
          </button>

          <button
            onClick={() => {
              closeContextMenu();
              useGameStore.getState().updateAgent(agentId, { currentTask: "Hold position..." });
            }}
            className="w-full text-left px-4 py-2 hover:bg-gray-800 flex items-center gap-2"
          >
            <span>✋</span> Hold Position
          </button>

          <button
            onClick={() => {
              closeContextMenu();
              useGameStore.getState().updateAgent(agentId, { currentTask: "Returning to base..." });
            }}
            className="w-full text-left px-4 py-2 hover:bg-gray-800 flex items-center gap-2"
          >
            <span>🏠</span> Return to Base
          </button>

          {dragons.length > 0 && (
            <>
              <div className="border-t border-gray-700 my-1" />
              <div className="px-4 py-1 text-xs text-red-400 font-semibold">NEARBY DRAGONS</div>
              {dragons.map((dragon) => (
                <div key={dragon.id} className="px-4 py-1">
                  <div className="text-sm text-gray-300 flex justify-between">
                    <span>{dragon.type} Dragon</span>
                    <span className="text-red-400">{dragon.health}/{dragon.maxHealth} HP</span>
                  </div>
                  <div className="flex gap-2 mt-1">
                    <button
                      onClick={() => handleAttack(dragon.id)}
                      className="flex-1 text-xs bg-red-700 hover:bg-red-600 py-1 rounded"
                    >
                      Attack
                    </button>
                    <button
                      onClick={() => handleAutoCombat(dragon.id)}
                      className="flex-1 text-xs bg-blue-700 hover:bg-blue-600 py-1 rounded"
                    >
                      Auto-Battle
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </motion.div>

      {/* Backdrop */}
      {contextMenuOpen && (
        <div
          className="fixed inset-0 z-40"
          onClick={closeContextMenu}
        />
      )}
    </>
  );
}

// ============================================================================
// Top Bar Component (Resource counts, etc.)
// ============================================================================

interface TopBarProps {
  className?: string;
}

export function TopBar({ className = "" }: TopBarProps) {
  const agentCount = useAgentCount();
  const dragonCount = useDragonCount();
  const questCount = useQuestCount();
  const completedQuests = useCompletedQuestCount();

  return (
    <motion.div
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      className={`absolute top-0 left-0 right-0 bg-gradient-to-b from-gray-900/90 to-transparent pt-2 pb-8 px-4 ${className}`}
    >
      <div className="flex justify-center gap-8">
        <div className="text-white text-center">
          <div className="text-2xl font-bold text-empire-gold">{agentCount}</div>
          <div className="text-xs text-gray-400">Agents</div>
        </div>
        <div className="text-white text-center">
          <div className="text-2xl font-bold text-empire-green">
            {completedQuests}/{questCount}
          </div>
          <div className="text-xs text-gray-400">Quests</div>
        </div>
        <div className="text-white text-center">
          <div className="text-2xl font-bold text-empire-red">{dragonCount}</div>
          <div className="text-xs text-gray-400">Dragons</div>
        </div>
      </div>
    </motion.div>
  );
}

// ============================================================================
// HUD Main Component
// ============================================================================

interface HUDProps {
  className?: string;
}

export function HUD({ className = "" }: HUDProps) {
  const contextMenuOpen = useGameStore((state) => state.contextMenuOpen);
  const contextMenuPosition = useGameStore((state) => state.contextMenuPosition);
  const contextMenuAgentId = useGameStore((state) => state.contextMenuAgentId);
  const closeContextMenu = useGameStore((state) => state.closeContextMenu);

  return (
    <div className={`pointer-events-none ${className}`}>
      {/* Top bar */}
      <TopBar />

      {/* Quest tracker */}
      <QuestTracker />

      {/* Minimap */}
      <Minimap />

      {/* Agent panel */}
      <AgentPanel />

      {/* Context menu (has pointer events) */}
      <AnimatePresence>
        {contextMenuOpen && contextMenuAgentId && contextMenuPosition && (
          <div className="pointer-events-auto">
            <ContextMenu
              agentId={contextMenuAgentId}
              position={contextMenuPosition}
              onClose={closeContextMenu}
            />
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
