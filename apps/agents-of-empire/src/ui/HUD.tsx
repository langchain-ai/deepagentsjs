import React, { useState, useCallback, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { shallow } from "zustand/shallow";
import { useGameStore, useSelectedAgentIds, useAgentsMap, useAgentsShallow, useQuestsShallow, useSelection, useAgentCount, useDragonCount, useQuestCount, useCompletedQuestCount, type GameAgent } from "../store/gameStore";
import { useAgentBridgeContext } from "../bridge/AgentBridge";
import { useCombat } from "../entities/Dragon";

// ============================================================================
// Minimap Component
// Classic RTS Position: Top-Right Corner
// Reference: StarCraft II, Age of Empires II
// ============================================================================

interface MinimapProps {
  width?: number;
  height?: number;
}

export function Minimap({ width = 220, height = 220 }: MinimapProps) {
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
      initial={{ opacity: 0, x: 50, y: -20 }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className="absolute top-4 right-4 bg-gray-900/95 border-2 border-empire-gold rounded-lg overflow-hidden shadow-lg shadow-empire-gold/20"
      style={{ width, height }}
    >
      {/* Classic RTS minimap header */}
      <div className="absolute top-0 left-0 right-0 h-6 bg-gradient-to-b from-empire-gold/20 to-transparent pointer-events-none" />

      <svg width={width} height={height} className="w-full h-full">
        {/* Background - classic RTS dark terrain */}
        <rect width={width} height={height} fill="#1a1a2e" />
        <rect width={width} height={height} fill="url(#terrainPattern)" opacity={0.3} />

        {/* Terrain pattern definition */}
        <defs>
          <pattern id="terrainPattern" patternUnits="userSpaceOnUse" width={20} height={20}>
            <rect width={20} height={20} fill="#1a1a2e" />
            <circle cx={10} cy={10} r={0.5} fill="#2a2a3e" />
          </pattern>
        </defs>

        {/* Structures - marked with distinctive icons */}
        {structures.map((structure) => (
          <g key={structure.id}>
            <circle
              cx={structure.position[0] * scale}
              cy={structure.position[2] * scale}
              r={structure.type === "castle" ? 6 : structure.type === "workshop" ? 5 : 4}
              fill="#f39c12"
              opacity={0.7}
            />
            {/* Structure border for visibility */}
            <circle
              cx={structure.position[0] * scale}
              cy={structure.position[2] * scale}
              r={structure.type === "castle" ? 6 : structure.type === "workshop" ? 5 : 4}
              fill="none"
              stroke="#f4d03f"
              strokeWidth={1}
            />
          </g>
        ))}

        {/* Dragons - enemies marked in red */}
        {dragons.map((dragon) => (
          <g key={dragon.id}>
            <circle
              cx={dragon.position[0] * scale}
              cy={dragon.position[2] * scale}
              r={4}
              fill="#e74c3c"
            />
            {/* Pulsing effect for enemies */}
            <circle
              cx={dragon.position[0] * scale}
              cy={dragon.position[2] * scale}
              r={6}
              fill="none"
              stroke="#e74c3c"
              strokeWidth={1}
              opacity={0.5}
            />
          </g>
        ))}

        {/* Agents - friendly units in blue */}
        {agents.map((agent) => (
          <g key={agent.id}>
            <circle
              cx={agent.position[0] * scale}
              cy={agent.position[2] * scale}
              r={selectedAgentIds.has(agent.id) ? 5 : 3}
              fill={selectedAgentIds.has(agent.id) ? "#f4d03f" : "#3498db"}
            />
            {/* Selection ring for selected agents */}
            {selectedAgentIds.has(agent.id) && (
              <circle
                cx={agent.position[0] * scale}
                cy={agent.position[2] * scale}
                r={7}
                fill="none"
                stroke="#f4d03f"
                strokeWidth={2}
              />
            )}
          </g>
        ))}

        {/* Camera view indicator - classic RTS feature */}
        <rect
          x={0}
          y={0}
          width={width * 0.3}
          height={height * 0.3}
          fill="none"
          stroke="#ffffff"
          strokeWidth={1.5}
          opacity={0.4}
          rx={2}
        />
      </svg>

      {/* Minimap label - classic RTS style */}
      <div className="absolute bottom-1 right-2 text-xs text-empire-gold font-bold tracking-wider">
        MINIMAP
      </div>

      {/* Compass indicator */}
      <div className="absolute top-1 left-2 text-xs text-gray-500 font-bold">
        N
      </div>
    </motion.div>
  );
}

// ============================================================================
// Agent Panel Component
// Classic RTS Position: Bottom-Left Corner
// Reference: StarCraft II command card, Age of Empires unit info
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
        transition={{ duration: 0.4, ease: "easeOut" }}
        className={`absolute bottom-4 left-4 bg-gray-900/95 border-2 border-empire-gold/50 rounded-lg p-4 text-white w-80 ${className}`}
      >
        <div className="text-center text-gray-400">
          <p className="text-lg font-semibold">No units selected</p>
          <p className="text-sm mt-1">Click on agents or drag to select multiple</p>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 50 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className={`absolute bottom-4 left-4 bg-gray-900/95 border-2 border-empire-gold rounded-lg p-4 text-white w-80 max-h-96 overflow-y-auto shadow-lg shadow-empire-gold/20 ${className}`}
    >
      {/* Classic RTS selection header */}
      <div className="flex justify-between items-center mb-3 pb-2 border-b border-empire-gold/30">
        <h3 className="text-empire-gold text-lg font-bold">
          {selectedAgents.length} Unit{selectedAgents.length > 1 ? "s" : ""} Selected
        </h3>
        <button
          onClick={clearSelection}
          className="text-gray-400 hover:text-white text-sm hover:bg-gray-700 px-2 py-1 rounded transition-colors"
        >
          Deselect
        </button>
      </div>

      <div className="space-y-3">
        {selectedAgents.map((agent) => (
          <div key={agent.id} className="bg-gray-800/80 rounded p-3 border border-empire-gold/30">
            <div className="flex justify-between items-start mb-2">
              <div>
                <div className="font-semibold text-empire-gold text-base">{agent.name}</div>
                <div className="text-xs text-gray-400">Level {agent.level} Agent</div>
              </div>
              <div className="text-xs px-2 py-1 rounded bg-gray-700 border border-gray-600">
                {agent.state}
              </div>
            </div>

            {/* Health bar - classic RTS style */}
            <div className="mb-2">
              <div className="flex justify-between text-xs mb-1">
                <span className="text-gray-400">Health</span>
                <span className={agent.health > 30 ? "text-green-400" : "text-red-400"}>
                  {agent.health}/{agent.maxHealth}
                </span>
              </div>
              <div className="h-2.5 bg-gray-700 rounded-full overflow-hidden border border-gray-600">
                <div
                  className="h-full transition-all duration-300"
                  style={{
                    width: `${(agent.health / agent.maxHealth) * 100}%`,
                    backgroundColor: agent.health > 50 ? "#27ae60" : agent.health > 30 ? "#f39c12" : "#e74c3c",
                  }}
                />
              </div>
            </div>

            {/* Current task */}
            {agent.currentTask && (
              <div className="text-xs text-gray-300 mb-2 bg-gray-900/50 px-2 py-1 rounded">
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
                  <span className="text-gray-500 italic">No tool equipped</span>
                )}
              </div>
              {agent.equippedTool && (
                <button
                  onClick={() => updateAgent(agent.id, { equippedTool: null })}
                  className="text-xs text-gray-400 hover:text-white hover:bg-gray-700 px-2 py-1 rounded transition-colors"
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
      className="absolute top-1/2 right-4 transform -translate-y-1/2 bg-gray-900/95 border-2 border-empire-gold rounded-lg p-4 text-white w-64 shadow-lg shadow-empire-gold/20"
    >
      <div className="flex justify-between items-center mb-4 pb-2 border-b border-empire-gold/30">
        <h3 className="text-empire-gold text-lg font-bold">Inventory</h3>
        {onClose && (
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white hover:bg-gray-700 w-6 h-6 rounded transition-colors"
          >
            ✕
          </button>
        )}
      </div>

      <div className="mb-4">
        <p className="text-sm text-gray-400 mb-2">{agent.name}'s Tools:</p>
        <div className="space-y-2">
          {agent.inventory.length === 0 ? (
            <p className="text-gray-500 text-sm italic">No tools available</p>
          ) : (
            agent.inventory.map((tool) => (
              <div
                key={tool.id}
                className={`p-2 rounded border cursor-pointer transition-all ${
                  agent.equippedTool?.id === tool.id
                    ? "bg-empire-gold text-gray-900 border-empire-gold shadow-lg shadow-empire-gold/30"
                    : "bg-gray-800 border-gray-700 hover:border-empire-gold/50"
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
          <div className="text-gray-400">🔍 Search</div>
          <div className="text-gray-400">🔨 Code Executor</div>
          <div className="text-gray-400">📜 File Reader</div>
          <div className="text-gray-400">🌐 Web Fetcher</div>
        </div>
      </div>
    </motion.div>
  );
}

// ============================================================================
// Quest Tracker Component
// Classic RTS Position: Top-Left Corner
// Reference: Age of Empires objectives panel, StarCraft II objectives
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
      initial={{ opacity: 0, x: -50, y: -20 }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className={`absolute top-4 left-4 bg-gray-900/95 border-2 border-empire-gold rounded-lg p-4 text-white w-80 shadow-lg shadow-empire-gold/20 ${className}`}
    >
      {/* Classic RTS objectives header */}
      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-empire-gold/30">
        <span className="text-empire-gold text-xl">📜</span>
        <h3 className="text-empire-gold text-lg font-bold">Objectives</h3>
      </div>

      {quests.length === 0 ? (
        <p className="text-gray-400 text-sm italic">No active objectives</p>
      ) : (
        <div className="space-y-2 max-h-60 overflow-y-auto">
          {quests.map((quest) => (
            <div
              key={quest.id}
              className={`p-3 rounded border transition-all ${
                quest.status === "completed"
                  ? "bg-green-900/30 border-green-600"
                  : quest.status === "in_progress"
                  ? "bg-yellow-900/30 border-yellow-600"
                  : "bg-gray-800/80 border-gray-700"
              }`}
            >
              <div className="flex justify-between items-start mb-1">
                <span className="font-semibold text-sm">{quest.title}</span>
                <span
                  className={`text-xs px-2 py-0.5 rounded font-medium ${
                    quest.status === "completed"
                      ? "bg-green-700 text-white"
                      : quest.status === "in_progress"
                      ? "bg-yellow-700 text-white"
                      : "bg-gray-600 text-gray-300"
                  }`}
                >
                  {quest.status === "completed"
                    ? "Done"
                    : quest.status === "in_progress"
                    ? "Active"
                    : "Pending"}
                </span>
              </div>
              <p className="text-xs text-gray-300 mb-2">{quest.description}</p>

              {quest.status === "pending" && selectedAgentIds.size > 0 && (
                <button
                  onClick={() => assignQuestToAgents(quest.id, Array.from(selectedAgentIds))}
                  className="text-xs bg-empire-gold text-gray-900 px-3 py-1 rounded font-semibold hover:bg-yellow-500 transition-colors"
                >
                  Assign ({selectedAgentIds.size})
                </button>
              )}

              {quest.status === "in_progress" && (
                <div className="text-xs text-gray-400">
                  {quest.assignedAgentIds.length} unit(s) assigned
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
        className="fixed bg-gray-900/95 border-2 border-empire-gold rounded-lg py-2 text-white w-56 z-50 shadow-xl shadow-empire-gold/20"
        style={{
          left: Math.min(position.x, window.innerWidth - 230),
          top: Math.min(position.y, window.innerHeight - 300),
        }}
      >
        <div className="px-4 py-2 border-b border-empire-gold/30 bg-empire-gold/10">
          <div className="font-bold text-empire-gold">{agent.name}</div>
          <div className="text-xs text-gray-400">Level {agent.level} • {agent.state}</div>
        </div>

        <div className="py-1">
          <button
            onClick={() => setShowInventory(true)}
            className="w-full text-left px-4 py-2 hover:bg-gray-800 flex items-center gap-2 transition-colors"
          >
            <span>🎒</span> Open Inventory
          </button>

          <button
            onClick={() => {
              closeContextMenu();
              useGameStore.getState().updateAgent(agentId, { currentTask: "Hold position..." });
            }}
            className="w-full text-left px-4 py-2 hover:bg-gray-800 flex items-center gap-2 transition-colors"
          >
            <span>✋</span> Hold Position
          </button>

          <button
            onClick={() => {
              closeContextMenu();
              useGameStore.getState().updateAgent(agentId, { currentTask: "Returning to base..." });
            }}
            className="w-full text-left px-4 py-2 hover:bg-gray-800 flex items-center gap-2 transition-colors"
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
                      className="flex-1 text-xs bg-red-700 hover:bg-red-600 py-1 rounded transition-colors"
                    >
                      Attack
                    </button>
                    <button
                      onClick={() => handleAutoCombat(dragon.id)}
                      className="flex-1 text-xs bg-blue-700 hover:bg-blue-600 py-1 rounded transition-colors"
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
// Classic RTS Position: Top Center
// Reference: StarCraft II resource display, Age of Empires resources
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
      transition={{ duration: 0.4, ease: "easeOut" }}
      className={`absolute top-0 left-0 right-0 bg-gradient-to-b from-gray-900/90 to-transparent pt-2 pb-8 px-4 ${className}`}
    >
      <div className="flex justify-center gap-8">
        {/* Classic RTS resource display style */}
        <div className="text-white text-center bg-gray-900/60 px-4 py-1 rounded-lg border border-empire-gold/30">
          <div className="text-2xl font-bold text-empire-gold">{agentCount}</div>
          <div className="text-xs text-gray-400">Units</div>
        </div>
        <div className="text-white text-center bg-gray-900/60 px-4 py-1 rounded-lg border border-empire-green/30">
          <div className="text-2xl font-bold text-empire-green">
            {completedQuests}/{questCount}
          </div>
          <div className="text-xs text-gray-400">Objectives</div>
        </div>
        <div className="text-white text-center bg-gray-900/60 px-4 py-1 rounded-lg border border-empire-red/30">
          <div className="text-2xl font-bold text-empire-red">{dragonCount}</div>
          <div className="text-xs text-gray-400">Threats</div>
        </div>
      </div>
    </motion.div>
  );
}

// ============================================================================
// HUD Main Component
// Combines all RTS-style UI elements
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
      {/* Top bar - Classic RTS resource display (top center) */}
      <TopBar />

      {/* Quest tracker - Classic RTS objectives panel (top-left) */}
      <QuestTracker />

      {/* Minimap - Classic RTS minimap (top-right) */}
      <Minimap />

      {/* Agent panel - Classic RTS unit info (bottom-left) */}
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
