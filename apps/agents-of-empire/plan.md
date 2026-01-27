# Implementation Plan: Agents of Empire

**Version:** 1.0
**Status:** Draft
**Last Updated:** 2025-01-26

---

## Overview

This document outlines the technical implementation strategy for **Agents of Empire**, a 3D RTS-style interface for the LangGraph Deep Agents framework.

**Goal:** Transform LangGraph Deep Agent workflows into an intuitive game interface where agents appear as characters, goals are buildings to capture, and errors are dragons to defeat.

---

## Technology Stack

### Core Dependencies

```json
{
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "@react-three/fiber": "^8.17.0",
    "@react-three/drei": "^9.114.0",
    "@react-three/postprocessing": "^2.16.0",
    "three": "^0.169.0",
    "zustand": "^5.0.0",
    "framer-motion": "^11.0.0",
    "immer": "^10.0.0",
    "uuid": "^11.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/three": "^0.169.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "tailwindcss": "^3.4.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0"
  }
}
```

### Stack Rationale

| Component | Choice | Why |
|-----------|--------|-----|
| **3D Rendering** | React Three Fiber + Drei | Declarative React API for Three.js, excellent TypeScript support, large ecosystem |
| **Camera** | Orthographic (isometric) | Classic RTS view, easier positioning and selection |
| **State** | Zustand | Lightweight, minimal boilerplate, perfect for game state |
| **UI** | React + Framer Motion | Fast development, smooth animations |
| **Build** | Vite | Instant HMR, TypeScript-first, fast builds |

---

## Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agents of Empire GUI                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │   Renderer   │────▶│  Game State  │◀────│   Input      │    │
│  │ (Three.js)   │     │  (Zustand)   │     │  Handler     │    │
│  └──────────────┘     └──────┬───────┘     └──────────────┘    │
│                               │                                 │
│                       ┌───────▼────────┐                        │
│                       │ Agent Bridge   │                        │
│                       │   (Adapter)    │                        │
│                       └───────┬────────┘                        │
│                               │                                 │
│  ┌────────────────────────────▼─────────────────────────────┐  │
│  │                   Deep Agents Library                     │  │
│  │  ┌──────────────────────────────────────────────────┐   │  │
│  │  │  createDeepAgent({                               │   │  │
│  │  │    tools, middleware, subagents, streaming, ...  │   │  │
│  │  │  })                                              │   │  │
│  │  └──────────────────────────────────────────────────┘   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Key Architectural Components

#### 1. Agent Bridge Layer (`src/bridge/`)

**Purpose:** Translate LangGraph events into game world updates

**Core Interface:**
```typescript
interface AgentBridge {
  // Spawn a new Deep Agent and create visual representation
  spawnAgent(config: AgentConfig): GameAgent;

  // Subscribe to LangGraph streaming events
  streamAgentEvents(agentId: string): AsyncIterator<AgentEvent>;

  // Map agent state to visual state
  syncVisualState(agent: DeepAgent, visual: GameAgent): void;

  // Handle tool execution visualization
  visualizeToolExecution(toolCall: ToolCall): void;
}
```

**Event Mapping:**

| Deep Agent Event | Game World Representation |
|------------------|---------------------------|
| `agent:created` | Spawn character at base with assigned appearance |
| `agent:thinking` | Character shows thought bubble, particles emit |
| `tool:call:start` | Character animation plays, tool icon appears |
| `subagent:spawned` | New character spawns near parent, linked by line |
| `file:written` | Document icon appears at character location |
| `error:occurred` | Dragon appears nearby, battle begins |
| `goal:completed` | Character returns to goal location, success effect |
| `checkpoint:reached` | Progress bar advances, flag appears on map |

#### 2. Game State Management (`src/store/`)

**Zustand Store Structure:**
```typescript
interface GameState {
  // Entities
  agents: Map<string, GameAgent>;
  structures: Map<string, Structure>;
  dragons: Map<string, Dragon>;

  // World
  camera: CameraState;
  terrain: TerrainState;
  selectedAgents: Set<string>;

  // UI
  activePanel: string | null;
  toolInHand: Tool | null;

  // Actions
  spawnAgent: (config: AgentConfig) => void;
  selectAgent: (id: string) => void;
  selectMultiple: (ids: string[]) => void;
  assignGoal: (agentIds: string[], goalId: string) => void;
  equipTool: (agentId: string, tool: Tool) => void;
}
```

#### 3. Entity Component System (`src/entities/`)

**GameAgent Entity:**
```typescript
class GameAgent extends THREE.Group {
  // Visual components
  private mesh: THREE.Group;
  private statusIndicator: StatusIndicator;
  private trailRenderer: TrailRenderer;

  // Agent state
  public state: AgentState;
  public currentTool: Tool | null;
  public inventory: InventoryItem[];

  // Animation state
  private animationState: AnimationState;

  // Update each frame
  update(delta: number): void {
    this.updateAnimation(delta);
    this.updateStatusIndicator();
    this.updateTrail();
  }
}

enum AgentState {
  IDLE = 'idle',
  THINKING = 'thinking',
  MOVING = 'moving',
  WORKING = 'working',
  ERROR = 'error',
  COMPLETING = 'completing'
}
```

---

## Project Structure

```
apps/agents-of-empire/
├── src/
│   ├── core/                    # Game engine, ECS, main loop
│   │   ├── Game.ts              # Main game class
│   │   ├── CameraController.ts  # RTS camera controls
│   │   ├── SelectionSystem.ts   # Drag/click selection
│   │   └── InputManager.ts      # Input handling
│   │
│   ├── world/                   # Map, terrain, structures
│   │   ├── WorldManager.ts      # World state, chunk system
│   │   ├── Terrain.ts           # Terrain generation
│   │   ├── Pathfinding.ts       # A* navigation
│   │   └── Structure.ts         # Buildings, castles, workshops
│   │
│   ├── entities/                # Agent representations, NPCs
│   │   ├── GameAgent.ts         # Agent character entity
│   │   ├── AgentPool.ts         # Agent spawning/management
│   │   ├── Dragon.ts            # Enemy dragons
│   │   └── ParticleEffects.ts   # Visual effects
│   │
│   ├── ui/                      # HUD panels, menus
│   │   ├── HUD.tsx              # Main HUD component
│   │   ├── AgentPanel.tsx       # Selected agent info
│   │   ├── InventoryPanel.tsx   # Tool inventory
│   │   ├── QuestPanel.tsx       # Goals/objectives
│   │   ├── Minimap.tsx          # Mini-map
│   │   └── ContextMenu.tsx      # Right-click menus
│   │
│   ├── bridge/                  # Deep Agents integration
│   │   ├── AgentBridge.ts       # Main bridge interface
│   │   ├── EventMapper.ts       # Event translation
│   │   ├── StateSync.ts         # State synchronization
│   │   └── StreamHandler.ts     # LangGraph streaming
│   │
│   ├── store/                   # State management
│   │   ├── gameStore.ts         # Zustand store
│   │   ├── agentSlice.ts        # Agent state slice
│   │   └── uiSlice.ts           # UI state slice
│   │
│   └── assets/                  # 3D models, textures, sounds
│       ├── models/              # GLTF models
│       ├── textures/            # PNG textures
│       └── sounds/              # Audio files
│
├── public/
│   └── icons/                   # UI icons
│
├── package.json
├── tsconfig.json
├── vite.config.ts
└── tailwind.config.js
```

---

## Implementation Phases

### Phase 1: Foundation (Weeks 1-2)

**Goal:** Basic 3D world with agent placement

**Tasks:**

1. **Project Setup**
   - Initialize Vite + React + TypeScript project
   - Install Three.js, R3F, Drei dependencies
   - Configure Tailwind CSS
   - Set up build pipeline

2. **Camera System**
   - Implement orthographic isometric camera
   - Add zoom with scroll wheel
   - Add pan with edge-scroll and middle-click drag
   - Smooth camera damping

3. **Terrain**
   - Create 10x10 grid terrain (expandable to 100x100)
   - Procedural terrain generation (Perlin noise)
   - Walkable/obstacle tile types
   - Ground textures/materials

4. **Basic Selection**
   - Click to select single agent
   - Drag box to select multiple
   - Visual selection indicators (highlight rings, selection box)

5. **Placeholder Agent**
   - Simple geometry character (cube/sphere with animations)
   - Click-to-move command
   - Basic pathfinding (A*)

**Deliverables:**
- Playable demo with terrain and movable character
- Selection box renderer
- Camera controller
- Basic pathfinding

**Files Created:**
- `src/core/Game.ts`
- `src/core/CameraController.ts`
- `src/core/SelectionSystem.ts`
- `src/world/Terrain.ts`
- `src/entities/GameAgent.ts` (placeholder)
- `src/world/Pathfinding.ts`

---

### Phase 2: Agent Bridge (Weeks 3-4)

**Goal:** Connect Deep Agents to game world

**Tasks:**

1. **AgentBridge Implementation**
   - Create bridge interface
   - Implement `spawnAgent()` to create Deep Agents
   - Connect to `createDeepAgent()` from Deep Agents library
   - Parse agent configurations

2. **Event Streaming**
   - Integrate with LangGraph `stream()` API
   - Parse `streamMode: ["updates"]` events
   - Handle `subgraphs: true` for subagent tracking
   - Event filtering and throttling

3. **State Visualization** ([DA-003](https://github.com/DavinciDreams/deepagentsjs/issues/32)) - COMPLETED
   - [x] Map agent states to animations (IDLE, THINKING, MOVING, WORKING, ERROR, COMPLETING)
   - [x] Update agent status indicators in real-time
   - [x] Show tool execution animations
   - [x] Enhanced visual effects per state (colors, animations, icons)
   - [x] Smooth transitions between states
   - [x] State color coding with glow effects
   - [x] ERROR state: Shake/jitter animation with red sparks
   - [x] COMPLETING state: Celebration particles with expanding ring
   - [x] MOVING state: Green trail effect behind agent
   - [x] WORKING state: Tool swing animation with orange glow
   - [x] THINKING state: Purple pulsing glow
   - [x] IDLE state: Gentle blue bob animation

4. **Subagent Visualization**
   - Spawn visual subagents near parent
   - Draw connection lines between parent and child
   - Track subagent lifecycle

5. **File Operations**
   - Show icons for file reads (scroll opening)
   - Show icons for file writes (document appearing)
   - Visual feedback for file operations

**Deliverables:**
- Working agent execution visible in game
- Real-time status updates
- Basic particle effects for actions
- Subagent spawning visuals

**Files Created:**
- `src/bridge/AgentBridge.ts`
- `src/bridge/EventMapper.ts`
- `src/bridge/StreamHandler.ts`
- `src/bridge/StateSync.ts`

**Critical Integration Points:**
- `libs/deepagents/src/agent.ts` - Main `createDeepAgent()` function
- `libs/deepagents/src/middleware/subagents.ts` - Subagent spawning
- `libs/deepagents/src/types.ts` - Type definitions

---

### Phase 3: UI Layer (Weeks 5-6)

**Goal:** Complete game UI overlay

**Tasks:**

1. **HUD Layout**
   - Minimap (top-right)
   - Agent panel (bottom-left)
   - Quest/goal tracker (top-left)
   - Inventory panel (right side)

2. **Agent Panel**
   - Selected agent details
   - Name, type, level, current task
   - Health/status bar
   - Current tool equipped
   - Agent state indicator

3. **Inventory Panel**
   - Drag-drop tool equipping
   - Tool categories with icons
   - Tool descriptions and stats
   - Rarity colors (common, rare, epic, legendary)

4. **Quest/Goal Tracker**
   - Active objectives list
   - Progress bars
   - Assigned agents per goal
   - Goal completion notifications

5. **Context Menus**
   - Right-click on agents
   - Right-click on map
   - Action options based on context

6. **Panel Animations**
   - Fade/slide transitions (Framer Motion)
   - Minimize/maximize panels
   - Responsive layout

**Deliverables:**
- Full RTS-style UI
- Panel animations
- Responsive layout
- Tooltips on all interactive elements

**Files Created:**
- `src/ui/HUD.tsx`
- `src/ui/AgentPanel.tsx`
- `src/ui/InventoryPanel.tsx`
- `src/ui/QuestPanel.tsx`
- `src/ui/Minimap.tsx`
- `src/ui/ContextMenu.tsx`

---

### Phase 4: Goal & Combat Systems (Weeks 7-8)

**Goal:** Quest objectives and error battles

**Tasks:**

1. **Goal Structures**
   - Castle (main goals, large structure on hill)
   - Tower (sub-goals, medium structures)
   - Workshop (active task areas)
   - Campfire (agent gathering/rest areas)

2. **Goal Assignment**
   - Drag agents to goal to assign
   - Select agents + right-click goal
   - Visual feedback for assignment

3. **Progress Tracking**
   - Progress bars on structures
   - Flags/checkpoints on map
   - Completion percentage

4. **Dragon Entity**
   - 3D dragon model (start with simple geometry)
   - Dragon types by error category
     - Syntax (red dragon, fire breath)
     - Runtime (purple dragon, magic attacks)
     - Network (blue dragon, lightning)
     - Permission (green dragon, poison gas)

5. **Combat Mechanics**
   - Spawn dragon on error occurrence
   - Agent enters combat stance
   - Auto-resolve (retry logic)
   - Manual intervention (optional)
   - Health bars for agent and dragon
   - Attack animations

6. **Victory/Defeat**
   - Victory effects (dragon defeated, error resolved)
   - Loot drops (power-ups, experience)
   - Defeat handling (agent respawn, retry)

**Deliverables:**
- Complete quest flow
- Dragon battles
- Victory celebrations
- Error resolution gameplay

**Files Created:**
- `src/world/Structure.ts`
- `src/world/GoalManager.ts`
- `src/entities/Dragon.ts`
- `src/entities/CombatSystem.ts`

---

### Phase 5: Polish & Features (Weeks 9-10)

**Goal:** Audio, visuals, and advanced features

**Tasks:**

1. **Audio**
   - Background music (intensity scales with activity)
   - Sound effects for tool types
   - Character vocalizations
   - Victory fanfares
   - Combat sounds

2. **Agent Personalities**
   - Visual variations (researcher, coder, data agent)
   - Animation differences
   - Tool preferences

3. **Coordination Visualization**
   - Connection lines between cooperating agents
   - Shared resource indicators
   - Formation movement patterns
   - Speech bubbles for communication

4. **Performance Optimization**
   - LOD system (Level of Detail)
   - Instanced rendering for multiple agents
   - Object pooling (particles, effects)
   - Spatial partitioning (quadtree)
   - Imposters for distant agents

5. **Persistence**
   - Save world state
   - Load previous sessions
   - Replay system

6. **Tutorial**
   - First-time user walkthrough
   - Interactive tooltips
   - Progressive disclosure

**Deliverables:**
- Production-ready application
- Tutorial system
- Save/load functionality
- Performance optimizations
- Audio complete

---

## Deep Agents Integration

### Critical Files to Reference

| File | Purpose | Location |
|------|---------|----------|
| `agent.ts` | Main `createDeepAgent()` function | `libs/deepagents/src/agent.ts` |
| `subagents.ts` | Subagent spawning logic | `libs/deepagents/src/middleware/subagents.ts` |
| `types.ts` | Type definitions | `libs/deepagents/src/types.ts` |
| `state.ts` | State backend implementation | `libs/deepagents/src/backends/state.ts` |
| `research-agent.ts` | Reference implementation | `examples/research/research-agent.ts` |

### Event Streaming Example

```typescript
// In AgentBridge.ts
async function streamAgentExecution(agentId: string) {
  const agent = this.agents.get(agentId);
  if (!agent) return;

  for await (const chunk of await agent.graph.stream(input, {
    streamMode: ["updates"],
    subgraphs: true,
  })) {
    // Map events to game state updates
    this.handleStreamEvent(chunk);
  }
}

function handleStreamEvent(event: StreamEvent) {
  switch (event.type) {
    case 'agent:thinking':
      this.setAgentState(event.agentId, AgentState.THINKING);
      this.playParticles(event.agentId, 'thought');
      break;
    case 'tool:call:start':
      this.setAgentState(event.agentId, AgentState.WORKING);
      this.animateToolUse(event.toolName);
      break;
    case 'error:occurred':
      this.spawnDragon(event.error, event.agentId);
      break;
    // ... more events
  }
}
```

---

## Performance Considerations

### Optimization Strategies

1. **Instanced Rendering**
   - Use `THREE.InstancedMesh` for multiple agents of same type
   - Reduces draw calls significantly

2. **LOD (Level of Detail)**
   - High-poly models when zoomed in
   - Medium-poly at medium distance
   - Low-poly or imposters when far away

3. **Object Pooling**
   - Reuse particle effects
   - Reuse selection indicators
   - Reuse connection lines

4. **Spatial Partitioning**
   - Quadtree for culling non-visible objects
   - Only render visible chunks

5. **State Throttling**
   - Limit update frequency for distant agents
   - Aggregate status for groups

### Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Frame rate | 60 FPS | With 100+ agents |
| Initial load | < 3s | Including Deep Agents library |
| Agent spawn | < 500ms | Per agent |
| Event latency | < 100ms | From Deep Agent to visual |
| Memory | < 2GB | With 200 agents |

---

## Verification Checklist

### Phase 1 Completion
- [ ] Launch game → See isometric world with terrain
- [ ] Scroll wheel → Camera zooms in/out smoothly
- [ ] Edge of screen → Camera pans
- [ ] Click agent → Agent highlights
- [ ] Drag box → Selection box appears, agents in box highlight
- [ ] Click ground → Selected agent moves to location
- [ ] Agent navigates around obstacles

### Phase 2 Completion
- [ ] Spawn agent → Real Deep Agent created
- [ ] Agent executes task → Visual state changes (THINKING → WORKING → COMPLETE)
- [ ] Tool execution → Animation plays, icon appears
- [ ] Subagent spawns → New character appears near parent
- [ ] File written → Document icon appears
- [x] Error occurs → Dragon spawns (COMB-001)

### Phase 3 Completion
- [x] Select agent → Agent panel shows details
- [x] Open inventory → See tools available with RPG-style representation
- [x] Tools show icons, names, descriptions, and rarity levels (common, rare, epic, legendary)
- [x] Rarity filter tabs for organizing inventory
- [x] Visual equipped tool indicator with ToolIcon component
- [ ] Drag tool to agent → Agent equips tool
- [x] Create goal → Goal structure appears on map (GOAL-001)
- [ ] Assign agent to goal → Agent moves to goal and shows working
- [x] Minimap → Shows all agents and structures

### Goal Structures Implementation (GOAL-001) - Completed 2025-01-27

**Files:**
- `src/entities/Structure.tsx` - All 5 goal structure types with unique 3D appearances
- `src/store/gameStore.ts` - Structure type definitions and state management
- `src/App.tsx` - Initial structure placement

**Features Implemented:**
1. **Five Structure Types** with distinct visual appearances:
   - **Castle** (main goals) - Large box geometry with 4 corner towers, gold color, subtle floating animation
   - **Tower** (sub-goals) - Cylinder with cone roof, orange color, floating animation
   - **Workshop** (tasks) - Box with pyramid roof and chimney, gray color
   - **Campfire** (spawn/gathering) - Animated flickering fire with light, red color
   - **Base** (HQ) - Box with flag pole and flag, blue color

2. **Visual Features:**
   - Each structure type has unique color and emissive properties
   - Name labels displayed above structures
   - Goal indicators (golden sphere + point light) for structures with goalId
   - Structure spawn effects with rising animation and particles
   - Structures visible on minimap (HUD.tsx)

3. **State Management:**
   - addStructure(), removeStructure(), updateStructure() in gameStore
   - Structure type: "castle" | "tower" | "workshop" | "campfire" | "base"
   - Structure interface includes id, type, position, name, description, goalId

4. **Initialization:**
   - 8 structures placed at game start (1 base, 1 castle, 2 towers, 2 workshops, 2 campfires)
   - Structures properly positioned on terrain

### Inventory System Implementation (INV-001) - Completed 2025-01-27

**Files Created:**
- `src/ui/ToolCard.tsx` - Tool representation components:
  - `ToolIcon` - Displays tool icon with rarity-based styling
  - `RarityBadge` - Shows rarity level (common/rare/epic/legendary)
  - `ToolCard` - Full RPG-style card with hover tooltips
  - `ToolListItem` - Compact list item for inventory
  - `TOOL_TYPE_CONFIG` - Tool type configuration (icons, colors, labels)
  - `RARITY_CONFIG` - Rarity configuration (colors, gradients, glow effects)

**Features Implemented:**
1. Tool Icons - Each tool type has a unique icon and color:
   - Search (🔍) - Blue
   - Code Executor (⚒️) - Red
   - File Reader (📜) - Green
   - Web Fetcher (🌐) - Purple
   - Subagent (🧙) - Orange

2. Rarity Levels - Visual distinction for each rarity:
   - Common (#95a5a6) - Gray/steel appearance
   - Rare (#3498db) - Blue with glow
   - Epic (#9b59b6) - Purple with shine effect
   - Legendary (#f4d03f) - Gold with strong glow

3. Enhanced InventoryPanel:
   - Currently equipped tool display
   - Rarity filter tabs (All, Common, Rare, Epic, Legendary)
   - Count badges showing tools per rarity
   - List view with ToolListItem components
   - Tool types legend
   - Equip/Unequip functionality

4. Visual Effects:
   - Glow effects based on rarity
   - Hover tooltips
   - Shine animation for epic/legendary tools
   - Smooth transitions with Framer Motion
   - Selection indicators for equipped tools

### Dragon Spawn on Error System (COMB-001) - Completed 2025-01-27

**Files:**
- `src/entities/Dragon.tsx` - Dragon visual component with 5 dragon types
- `src/store/gameStore.ts` - Dragon state management (spawn, remove, update, damage)
- `src/bridge/AgentBridge.tsx` - Error handling flow that spawns dragons
- `src/ui/HUD.tsx` - Dragon count display and test keyboard shortcut

**Features Implemented:**
1. **Five Dragon Types** based on error category:
   - **SYNTAX** (Red) - Fire-breathing dragon for parse/syntax errors
   - **RUNTIME** (Purple) - Magic-wielding sphere creature for execution errors
   - **NETWORK** (Blue) - Angular tech dragon with lightning for network errors
   - **PERMISSION** (Green) - Snake-like poison dragon for access/auth errors
   - **UNKNOWN** (Dark) - Shadowy tentacled form for unrecognized errors

2. **Dragon Visual Features:**
   - Unique 3D geometry per dragon type
   - Hovering animation (sine wave floating)
   - Breathing animation (scale pulsing)
   - Type-specific particle effects (fire, magic aura, lightning, poison, dark tendrils)
   - Health bar above dragon showing HP
   - Error message displayed as text label
   - Shadow on ground

3. **Error to Dragon Mapping:**
   - Keywords in error message automatically determine dragon type
   - "syntax" or "parse" → SYNTAX dragon
   - "network", "fetch", "connection" → NETWORK dragon
   - "permission", "access", "auth" → PERMISSION dragon
   - "runtime", "execution" → RUNTIME dragon
   - Default → UNKNOWN dragon

4. **Combat System:**
   - `useCombat()` hook with `attackDragon()` and `autoResolveCombat()` functions
   - Damage calculation based on agent level
   - Dragon counter-attacks
   - XP gain on victory
   - Agent defeat/retreat logic

5. **State Management:**
   - `spawnDragon(type, position, error, targetAgentId)` in gameStore
   - Dragon count tracked in `dragonCount` for UI display
   - `removeDragon()` cleanup after defeat
   - `updateDragon()` for health/state changes
   - `damageDragon()` for combat damage

6. **Testing:**
   - Press `Shift+D` to spawn a random test dragon
   - Dragon spawns near random agent
   - Logs to console with dragon type

### Phase 4 Completion
- [x] Agent encounters error → Dragon spawns nearby (COMB-001)
- [x] Dragon appears → Agent enters combat stance (COMB-001)
- [x] Battle plays out → Health bars change (COMB-001)
- [x] Victory → Dragon defeated, loot appears (COMB-001 - XP granted)
- [ ] Goal complete → Progress bar fills, celebration effects

### Phase 5 Completion
- [ ] 100+ agents on screen → 60 FPS maintained
- [x] Zoom out → See entire battlefield (MAP-002)
- [ ] Save game → State persists
- [ ] Load game → Previous state restored
- [ ] New user → Tutorial guides them through

### MAP-002: Zoom in/out with scroll wheel - Completed 2025-01-27

**Files Modified:**
- `src/core/CameraController.ts` - Enhanced zoom range and speed, added height clamping
- `src/store/gameStore.ts` - Updated zoom limits in setZoom function

**Features Implemented:**
1. **Expanded Zoom Range** (0.2x to 5.0x = 25x range):
   - 0.2x: Extreme close-up (agent inspection)
   - 0.5x: Close view (single agent detail)
   - 1.0x: Medium-close view (multiple agents)
   - 2.0x: Standard tactical view (default)
   - 5.0x: Full map overview (50x50 tiles visible)

2. **Improved Zoom Speed**:
   - Increased from 0.001 to 0.002 (2x faster)
   - More responsive to scroll wheel input
   - Smooth interpolation maintained with existing damping system

3. **Terrain Clipping Prevention**:
   - Added MIN_CAMERA_HEIGHT constant (5 units)
   - Camera height clamped in useFrame loop
   - Prevents camera from clipping through terrain at max zoom

4. **Acceptance Criteria Met**:
   - Smooth zoom from individual agent to full map - PASS (25x zoom range)
   - Scroll wheel controls zoom level - PASS (existing implementation, enhanced range)
   - Zoom limits to prevent clipping - PASS (height clamping added)
   - Smooth interpolation - PASS (existing damping system)

---

## Open Questions & Decisions Needed

1. **Combat Depth**: Should dragons be full tactical battles or simplified auto-resolve?
   - *Decision point: Week 6*

2. **Character Models**: Use 3D models or stylized geometry?
   - *Decision point: Week 4*

3. **Multiplayer**: Should this be in initial scope?
   - *Decision point: Week 8*

4. **Persistence**: What needs to persist between sessions?
   - *Decision point: Week 9*

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Three.js learning curve | Medium | Use React Three Fiber for React ergonomics |
| Performance at scale | High | LOD, instancing, spatial partitioning |
| Deep Agents API changes | High | Build abstraction layer in AgentBridge |
| User adoption of game metaphor | Medium | User testing, iterate on UX |
| Browser compatibility | Low | Test early, use polyfills |

---

## Inspirations & References

- [Ralv - Starcraft for AI Agents](https://ralv.ai/)
- [React Three Fiber Examples](https://docs.pmnd.rs/react-three-fiber/getting-started/examples)
- [Three.js RTS Game Engine](https://github.com/andvolodko/three.js-rts-ecs-engine)
- [Isometric Games with PixiJS](https://pixijs.com/)

---

**Next Steps:**
1. Review and approve this plan
2. Set up project infrastructure
3. Begin Phase 1: Foundation
