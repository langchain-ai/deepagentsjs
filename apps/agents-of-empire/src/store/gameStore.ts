import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { v4 as uuidv4 } from "uuid";

// ============================================================================
// Types
// ============================================================================

export type AgentState = "IDLE" | "THINKING" | "MOVING" | "WORKING" | "ERROR" | "COMPLETING" | "COMBAT";

export type ToolType = "search" | "code_executor" | "file_reader" | "web_fetcher" | "subagent";

export type Rarity = "common" | "rare" | "epic" | "legendary";

export interface Tool {
  id: string;
  name: string;
  type: ToolType;
  icon: string;
  description: string;
  rarity: Rarity;
  power?: number; // Optional power stat for gameplay
}

export interface GameAgent {
  id: string;
  name: string;
  position: [number, number, number];
  targetPosition: [number, number, number] | null;
  state: AgentState;
  level: number;
  health: number;
  maxHealth: number;
  equippedTool: Tool | null;
  inventory: Tool[];
  currentTask: string;
  agentRef: any; // Reference to Deep Agent
  parentId: string | null; // For subagents
  childrenIds: string[]; // For tracking spawned subagents
  thoughtBubble: string | null;
  lastToolCall: string | null;
}

export type DragonType = "SYNTAX" | "RUNTIME" | "NETWORK" | "PERMISSION" | "UNKNOWN";

export interface Dragon {
  id: string;
  type: DragonType;
  position: [number, number, number];
  health: number;
  maxHealth: number;
  error: string;
  targetAgentId: string | null;
}

export type StructureType = "castle" | "tower" | "workshop" | "campfire" | "base";

export interface Structure {
  id: string;
  type: StructureType;
  position: [number, number, number];
  name: string;
  description: string;
  goalId?: string;
}

export type QuestStatus = "pending" | "in_progress" | "completed" | "failed";

export interface Quest {
  id: string;
  title: string;
  description: string;
  status: QuestStatus;
  targetStructureId: string | null;
  requiredAgents: number;
  assignedAgentIds: string[];
  rewards: string[];
}

export type TileType = "grass" | "dirt" | "stone" | "water" | "path";

export interface Tile {
  x: number;
  z: number;
  type: TileType;
  walkable: boolean;
}

// ============================================================================
// Store State
// ============================================================================

interface GameState {
  // World
  worldSize: { width: number; height: number };
  tiles: Record<string, Tile>;

  // Agents
  agents: Record<string, GameAgent>;
  selectedAgentIds: Set<string>;
  agentCount: number; // Cached count for UI

  // Dragons (errors)
  dragons: Record<string, Dragon>;
  dragonCount: number; // Cached count for UI

  // Structures
  structures: Record<string, Structure>;
  structureCount: number; // Cached count for UI

  // Quests
  quests: Record<string, Quest>;
  questCount: number; // Cached count for UI
  completedQuestCount: number; // Cached count for UI

  // Camera
  cameraPosition: { x: number; y: number; z: number };
  cameraTarget: { x: number; y: number; z: number };
  zoom: number;
  cameraRotation: number; // Rotation angle around Y axis in radians
  cameraRotationTarget: number; // Target rotation for smooth transitions
  cameraElevation: number; // Elevation angle from horizontal in radians
  cameraElevationTarget: number; // Target elevation for smooth transitions

  // UI State
  isDragging: boolean;
  dragStart: { x: number; y: number } | null;
  dragEnd: { x: number; y: number } | null;
  selectionBox: { startX: number; startY: number; endX: number; endY: number; active: boolean } | null;
  hoverAgentId: string | null;
  hoverStructureId: string | null;
  contextMenuOpen: boolean;
  contextMenuPosition: { x: number; y: number } | null;
  contextMenuAgentId: string | null;

  // Active goals
  activeGoalId: string | null;
}

// ============================================================================
// Store Actions
// ============================================================================

interface GameActions {
  // World
  initializeWorld: (width: number, height: number) => void;
  setTile: (x: number, z: number, tile: Partial<Tile>) => void;

  // Agents
  spawnAgent: (
    name: string,
    position: [number, number, number],
    agentRef?: any,
    parentId?: string
  ) => GameAgent;
  spawnAgentBatch: (
    count: number,
    basePosition?: [number, number, number],
    pattern?: "random" | "grid" | "circle"
  ) => GameAgent[];
  removeAgent: (id: string) => void;
  updateAgent: (id: string, updates: Partial<GameAgent>) => void;
  setAgentState: (id: string, state: AgentState) => void;
  setAgentPosition: (id: string, position: [number, number, number]) => void;
  setAgentTarget: (id: string, target: [number, number, number]) => void;
  equipTool: (agentId: string, tool: Tool) => void;
  unequipTool: (agentId: string) => void;
  addToolToInventory: (agentId: string, tool: Tool) => void;
  setThoughtBubble: (agentId: string, thought: string | null) => void;

  // Selection
  selectAgent: (id: string) => void;
  deselectAgent: (id: string) => void;
  toggleAgentSelection: (id: string) => void;
  selectAgentsInBox: (
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number
  ) => void;
  clearSelection: () => void;
  selectAllAgents: () => void;

  // Dragons
  spawnDragon: (
    type: DragonType,
    position: [number, number, number],
    error: string,
    targetAgentId: string
  ) => Dragon;
  removeDragon: (id: string) => void;
  updateDragon: (id: string, updates: Partial<Dragon>) => void;
  damageDragon: (id: string, damage: number) => void;

  // Structures
  addStructure: (structure: Omit<Structure, "id">) => Structure;
  removeStructure: (id: string) => void;
  updateStructure: (id: string, updates: Partial<Structure>) => void;

  // Quests
  addQuest: (quest: Omit<Quest, "id">) => Quest;
  updateQuest: (id: string, updates: Partial<Quest>) => void;
  assignQuestToAgents: (questId: string, agentIds: string[]) => void;
  completeQuest: (id: string) => void;

  // Camera
  setCameraPosition: (position: { x: number; y: number; z: number }) => void;
  setCameraTarget: (target: { x: number; y: number; z: number }) => void;
  setZoom: (zoom: number) => void;
  setCameraRotation: (rotation: number) => void;
  setCameraElevation: (elevation: number) => void;

  // UI
  startDrag: (position: { x: number; y: number }) => void;
  updateDrag: (position: { x: number; y: number }) => void;
  endDrag: () => void;
  startSelectionBox: (startX: number, startY: number) => void;
  updateSelectionBox: (endX: number, endY: number) => void;
  endSelectionBox: () => void;
  setHoverAgent: (id: string | null) => void;
  setHoveredStructure: (id: string | null) => void;
  openContextMenu: (position: { x: number; y: number }, agentId: string) => void;
  closeContextMenu: () => void;

  // Goals
  setActiveGoal: (goalId: string | null) => void;

  // Batch updates
  updateMultipleAgents: (updates: Array<{ id: string; changes: Partial<GameAgent> }>) => void;
}

// ============================================================================
// Store Definition
// ============================================================================

type GameStore = GameState & GameActions;

export const useGameStore = create<GameStore>()(
  immer((set, get) => ({
    // Initial State
    worldSize: { width: 50, height: 50 },
    tiles: {},
    agents: {},
    selectedAgentIds: new Set(),
    agentCount: 0,
    dragons: {},
    dragonCount: 0,
    structures: {},
    structureCount: 0,
    quests: {},
    questCount: 0,
    completedQuestCount: 0,
    cameraPosition: { x: 25, y: 30, z: 25 },
    cameraTarget: { x: 0, y: 0, z: 0 },
    zoom: 1,
    cameraRotation: Math.PI / 4, // 45 degrees default
    cameraRotationTarget: Math.PI / 4,
    cameraElevation: Math.asin(Math.tan(Math.PI / 6)), // ~35.26 degrees (true isometric)
    cameraElevationTarget: Math.asin(Math.tan(Math.PI / 6)),
    isDragging: false,
    dragStart: null,
    dragEnd: null,
    selectionBox: null,
    hoverAgentId: null,
    hoverStructureId: null,
    contextMenuOpen: false,
    contextMenuPosition: null,
    contextMenuAgentId: null,
    activeGoalId: null,

  // World Actions
  initializeWorld: (width, height) => {
    set((state) => {
      state.worldSize = { width, height };
      state.tiles = {};
      for (let x = 0; x < width; x++) {
        for (let z = 0; z < height; z++) {
          const key = `${x},${z}`;
          const type: TileType = Math.random() < 0.05 ? "stone" : "grass";
          state.tiles[key] = { x, z, type, walkable: type !== "water" };
        }
      }
    });
  },

  setTile: (x, z, tileUpdates) => {
    const key = `${x},${z}`;
    set((state) => {
      const existing = state.tiles[key];
      if (existing) {
        Object.assign(state.tiles[key], tileUpdates);
      }
    });
  },

  // Agent Actions
  spawnAgent: (name, position, agentRef, parentId) => {
    const id = uuidv4();
    const agent: GameAgent = {
      id,
      name,
      position,
      targetPosition: null,
      state: "IDLE",
      level: 1,
      health: 100,
      maxHealth: 100,
      equippedTool: null,
      inventory: [],
      currentTask: "Awaiting orders...",
      agentRef,
      parentId: parentId || null,
      childrenIds: [],
      thoughtBubble: null,
      lastToolCall: null,
    };

    set((state) => {
      state.agents[id] = agent;
      state.agentCount = state.agentCount + 1;

      // If this is a subagent, link it to parent
      if (parentId && state.agents[parentId]) {
        state.agents[parentId].childrenIds.push(id);
      }
    });

    return agent;
  },

  spawnAgentBatch: (count, basePosition, pattern) => {
    const base = basePosition || [25, 0, 25];
    const spawnPattern = pattern || "grid";
    const agents: GameAgent[] = [];
    const spawnRadius = 20;

    if (spawnPattern === "grid") {
      // Grid pattern for organized deployment
      const gridSize = Math.ceil(Math.sqrt(count));
      const spacing = 2;
      const offset = (gridSize * spacing) / 2;

      for (let i = 0; i < count; i++) {
        const row = Math.floor(i / gridSize);
        const col = i % gridSize;
        const position: [number, number, number] = [
          base[0] + col * spacing - offset,
          base[1],
          base[2] + row * spacing - offset,
        ];
        agents.push(get().spawnAgent(`Agent-${i + 1}`, position));
      }
    } else if (spawnPattern === "circle") {
      // Circle pattern for defensive formation
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        const position: [number, number, number] = [
          base[0] + Math.cos(angle) * spawnRadius,
          base[1],
          base[2] + Math.sin(angle) * spawnRadius,
        ];
        agents.push(get().spawnAgent(`Agent-${i + 1}`, position));
      }
    } else {
      // Random pattern (default)
      for (let i = 0; i < count; i++) {
        const position: [number, number, number] = [
          base[0] + (Math.random() - 0.5) * spawnRadius * 2,
          base[1],
          base[2] + (Math.random() - 0.5) * spawnRadius * 2,
        ];
        agents.push(get().spawnAgent(`Agent-${i + 1}`, position));
      }
    }

    return agents;
  },

  removeAgent: (id) => {
    set((state) => {
      const agent = state.agents[id];

      // Remove from parent's children
      if (agent?.parentId && state.agents[agent.parentId]) {
        state.agents[agent.parentId].childrenIds = state.agents[agent.parentId].childrenIds.filter(
          (childId) => childId !== id
        );
      }

      delete state.agents[id];
      state.selectedAgentIds.delete(id);
      state.agentCount = Math.max(0, state.agentCount - 1);
    });
  },

  updateAgent: (id, updates) => {
    set((state) => {
      const agent = state.agents[id];
      if (agent) {
        Object.assign(state.agents[id], updates);
      }
    });
  },

  setAgentState: (id, state) => {
    get().updateAgent(id, { state });
  },

  setAgentPosition: (id, position) => {
    get().updateAgent(id, { position });
  },

  setAgentTarget: (id, target) => {
    get().updateAgent(id, { targetPosition: target });
  },

  equipTool: (agentId, tool) => {
    get().updateAgent(agentId, { equippedTool: tool });
  },

  unequipTool: (agentId) => {
    get().updateAgent(agentId, { equippedTool: null });
  },

  addToolToInventory: (agentId, tool) => {
    set((state) => {
      const agent = state.agents[agentId];
      if (agent) {
        state.agents[agentId].inventory = [...agent.inventory, tool];
      }
    });
  },

  setThoughtBubble: (agentId, thought) => {
    get().updateAgent(agentId, { thoughtBubble: thought });
  },

  // Selection Actions
  selectAgent: (id) => {
    set((state) => {
      state.selectedAgentIds.add(id);
    });
  },

  deselectAgent: (id) => {
    set((state) => {
      state.selectedAgentIds.delete(id);
    });
  },

  toggleAgentSelection: (id) => {
    set((state) => {
      if (state.selectedAgentIds.has(id)) {
        state.selectedAgentIds.delete(id);
      } else {
        state.selectedAgentIds.add(id);
      }
    });
  },

  selectAgentsInBox: (minX, minZ, maxX, maxZ) => {
    set((state) => {
      const selected = new Set<string>();
      for (const id in state.agents) {
        const agent = state.agents[id];
        const [x, , z] = agent.position;
        if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) {
          selected.add(id);
        }
      }
      state.selectedAgentIds = selected;
    });
  },

  clearSelection: () => {
    set({ selectedAgentIds: new Set() });
  },

  selectAllAgents: () => {
    set((state) => {
      state.selectedAgentIds = new Set(Object.keys(state.agents));
    });
  },

  // Dragon Actions
  spawnDragon: (type, position, error, targetAgentId) => {
    const id = uuidv4();
    const maxHealth = type === "UNKNOWN" ? 200 : 100;
    const dragon: Dragon = {
      id,
      type,
      position,
      health: maxHealth,
      maxHealth,
      error,
      targetAgentId,
    };

    set((state) => {
      state.dragons[id] = dragon;
      state.dragonCount = state.dragonCount + 1;
    });

    return dragon;
  },

  removeDragon: (id) => {
    set((state) => {
      delete state.dragons[id];
      state.dragonCount = Math.max(0, state.dragonCount - 1);
    });
  },

  updateDragon: (id, updates) => {
    set((state) => {
      const dragon = state.dragons[id];
      if (dragon) {
        Object.assign(state.dragons[id], updates);
      }
    });
  },

  damageDragon: (id, damage) => {
    set((state) => {
      const dragon = state.dragons[id];
      if (dragon) {
        state.dragons[id].health = Math.max(0, dragon.health - damage);
      }
    });
  },

  // Structure Actions
  addStructure: (structure) => {
    const id = uuidv4();
    const newStructure: Structure = { ...structure, id };
    set((state) => {
      state.structures[id] = newStructure;
      state.structureCount = state.structureCount + 1;
    });
    return newStructure;
  },

  removeStructure: (id) => {
    set((state) => {
      delete state.structures[id];
      state.structureCount = Math.max(0, state.structureCount - 1);
    });
  },

  updateStructure: (id, updates) => {
    set((state) => {
      const structure = state.structures[id];
      if (structure) {
        Object.assign(state.structures[id], updates);
      }
    });
  },

  // Quest Actions
  addQuest: (quest) => {
    const id = uuidv4();
    const newQuest: Quest = { ...quest, id };
    const isNewCompleted = newQuest.status === "completed";
    set((state) => {
      state.quests[id] = newQuest;
      state.questCount = state.questCount + 1;
      state.completedQuestCount = state.completedQuestCount + (isNewCompleted ? 1 : 0);
    });
    return newQuest;
  },

  updateQuest: (id, updates) => {
    set((state) => {
      const quest = state.quests[id];
      if (quest) {
        const oldCompleted = quest.status === "completed";
        Object.assign(state.quests[id], updates);
        const newCompleted = (updates.status ?? quest.status) === "completed";
        const completedDelta = newCompleted ? 1 : 0 - (oldCompleted ? 1 : 0);
        state.completedQuestCount = Math.max(0, state.completedQuestCount + completedDelta);
      }
    });
  },

  assignQuestToAgents: (questId, agentIds) => {
    get().updateQuest(questId, {
      assignedAgentIds: agentIds,
      status: "in_progress",
    });
  },

  completeQuest: (id) => {
    get().updateQuest(id, { status: "completed" });
  },

  // Camera Actions
  setCameraPosition: (position) => {
    set({ cameraPosition: position });
  },

  setCameraTarget: (target) => {
    set({ cameraTarget: target });
  },

  setZoom: (zoom) => {
    set({ zoom: Math.max(0.2, Math.min(5.0, zoom)) });
  },

  setCameraRotation: (rotation) => {
    set({
      cameraRotation: rotation,
      cameraRotationTarget: rotation,
    });
  },

  setCameraElevation: (elevation) => {
    set({
      cameraElevation: elevation,
      cameraElevationTarget: elevation,
    });
  },

  // UI Actions
  startDrag: (position) => {
    set({ isDragging: true, dragStart: position, dragEnd: position });
  },

  updateDrag: (position) => {
    set({ dragEnd: position });
  },

  endDrag: () => {
    set({ isDragging: false, dragStart: null, dragEnd: null });
  },

  startSelectionBox: (startX, startY) => {
    set({
      selectionBox: {
        startX,
        startY,
        endX: startX,
        endY: startY,
        active: true,
      },
    });
  },

  updateSelectionBox: (endX, endY) => {
    set((state) => {
      if (state.selectionBox) {
        state.selectionBox.endX = endX;
        state.selectionBox.endY = endY;
      }
    });
  },

  endSelectionBox: () => {
    set({ selectionBox: null });
  },

  setHoverAgent: (id) => {
    set({ hoverAgentId: id });
  },

  setHoveredStructure: (id) => {
    set({ hoverStructureId: id });
  },

  openContextMenu: (position, agentId) => {
    set({
      contextMenuOpen: true,
      contextMenuPosition: position,
      contextMenuAgentId: agentId,
    });
  },

  closeContextMenu: () => {
    set({
      contextMenuOpen: false,
      contextMenuPosition: null,
      contextMenuAgentId: null,
    });
  },

  // Goals
  setActiveGoal: (goalId) => {
    set({ activeGoalId: goalId });
  },

  // Batch updates
  updateMultipleAgents: (updates) => {
    set((state) => {
      for (const { id, changes } of updates) {
        const agent = state.agents[id];
        if (agent) {
          Object.assign(state.agents[id], changes);
        }
      }
    });
  },
})));

// ============================================================================
// Selector Hooks
// ============================================================================

import { shallow } from "zustand/shallow";

// Use cached count values - these are stable scalar values
export const useAgentCount = () => useGameStore((state) => state.agentCount);
export const useDragonCount = () => useGameStore((state) => state.dragonCount);
export const useStructureCount = () => useGameStore((state) => state.structureCount);
export const useQuestCount = () => useGameStore((state) => state.questCount);
export const useCompletedQuestCount = () => useGameStore((state) => state.completedQuestCount);

// Single agent lookup
export const useAgent = (id: string) =>
  useGameStore((state) => state.agents.get(id));

// Selected agents - return Set and Map for stable reference
export const useSelectedAgentIds = () => useGameStore((state) => state.selectedAgentIds);
export const useAgentsMap = () => useGameStore((state) => state.agents);

// These selectors use shallow comparison for the Map reference itself
// Components should use useMemo to convert to arrays when needed
export const useAgentsShallow = () => useGameStore((state) => state.agents, shallow);
export const useDragonsShallow = () => useGameStore((state) => state.dragons, shallow);
export const useStructuresShallow = () => useGameStore((state) => state.structures, shallow);
export const useQuestsShallow = () => useGameStore((state) => state.quests, shallow);
export const useTilesShallow = () => useGameStore((state) => state.tiles, shallow);

// Selection Set
export const useSelection = () => useGameStore((state) => state.selectedAgentIds);

// Camera state selectors - return stable values to avoid infinite loops
export const useCameraPosition = () => useGameStore((state) => state.cameraPosition);
export const useCameraTarget = () => useGameStore((state) => state.cameraTarget);
export const useZoom = () => useGameStore((state) => state.zoom);
export const useSetCameraPosition = () => useGameStore((state) => state.setCameraPosition);
export const useSetCameraTarget = () => useGameStore((state) => state.setCameraTarget);
export const useSetZoom = () => useGameStore((state) => state.setZoom);
export const useCameraRotation = () => useGameStore((state) => state.cameraRotation);
export const useCameraRotationTarget = () => useGameStore((state) => state.cameraRotationTarget);
export const useCameraElevation = () => useGameStore((state) => state.cameraElevation);
export const useCameraElevationTarget = () => useGameStore((state) => state.cameraElevationTarget);
export const useSetCameraRotation = () => useGameStore((state) => state.setCameraRotation);
export const useSetCameraElevation = () => useGameStore((state) => state.setCameraElevation);
