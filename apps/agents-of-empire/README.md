# Agents of Empire

> "Starcraft for AI Agents" - A 3D RTS-style GUI for LangGraph Deep Agents where agents appear as characters on a map, you drag-select to command them, and they collaborate toward goals while battling "TypeScript dragons" (errors).

![Agents of Empire](https://img.shields.io/badge/Three.js-3D%20RTS-black?style=for-the-badge&logo=three.js)
![LangGraph](https://img.shields.io/badge/LangGraph-Deep%20Agents-blue?style=for-the-badge)

## Vision

Not a node editor. A real game interface where:
- **Agents are visible characters** you can select and command
- **Goals are physical locations** (castles, buildings) on the map
- **Tools are equipped** like RPG inventory items
- **Errors spawn dragons** that agents must battle
- **Agent coordination is visible** on the battlefield

## Tech Stack

| Component | Choice |
|-----------|--------|
| **3D Rendering** | React Three Fiber + Drei |
| **State Management** | Zustand |
| **UI Overlay** | Tailwind CSS + Framer Motion |
| **Camera** | Orthographic (isometric) |

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm

### Installation

```bash
# From the monorepo root
pnpm install

# Or install just this app
cd apps/agents-of-empire
pnpm install
```

### Development

```bash
pnpm dev
```

The app will be available at `http://localhost:3000` (or another port if 3000 is in use).

**Note:** The app opens with a stunning landing page showcasing the game's features and launch roadmap. Click "🎮 Enter the Game" to access the 3D RTS interface.

### Build

```bash
pnpm build
```

## Landing Page

The app opens with an immersive landing page featuring:

- **Hero Section**: Bold gaming aesthetic with "Starcraft for AI Agents" tagline
- **Features Grid**: Six key features showcased with emoji icons
  - RTS-Style Controls
  - Agent Visualization
  - Battle Dragons
  - Equip Tools
  - Strategic Map
  - Real-Time Coordination
- **Launch Roadmap**: Interactive timeline showing development phases
  - MVP (8 weeks) - Active
  - Enhancement (6 weeks)
  - Advanced Features (8 weeks)
  - Multiplayer (12 weeks)
- **Dark Gaming Theme**: Vibrant orange (#ff6b35) and cyan (#00d4ff) accents on dark background
- **Framer Motion Animations**: Smooth scroll reveals, hover effects, and staggered animations
- **Responsive Design**: Works on desktop, tablet, and mobile
- **Interactive Background**: Animated perspective grid with floating gradient orbs

## Controls

| Action | Control |
|--------|---------|
| Select Agent | Left-click |
| Select Multiple | Drag box or Shift+click |
| Move Agents | Right-click on ground |
| Open Context Menu | Right-click on agent |
| Pan Camera | WASD / Arrow keys / Middle-click drag |
| Zoom | Scroll wheel |
| Edge Scroll | Move mouse to screen edge |

## Features

### Phase 1: Foundation ✅
- [x] Isometric terrain grid (procedural generation)
- [x] Pathfinding for agent movement (A*)
- [x] Structure placement (castles, camps, workshops)
- [x] RTS-style isometric camera
- [x] Zoom in/out with scroll
- [x] Pan with edge-scroll or middle-click drag
- [x] Click to select single agent
- [x] Drag box to select multiple agents
- [x] Visual selection indicators
- [x] 3D agent characters
- [x] States: IDLE, THINKING, MOVING, WORKING, ERROR, COMPLETING
- [x] Status indicators, animations

### Phase 2: Agent Bridge ✅
- [x] AgentBridge for Deep Agents integration
- [x] Spawn Deep Agents as visual characters
- [x] Map agent state to visual state
- [x] Event type definitions

### Phase 3: UI Overlay ✅
- [x] Minimap (top-right corner)
- [x] Agent Panel (bottom-left)
- [x] Inventory Panel (right side)
- [x] Quest/Goal Tracker (top-left)
- [x] Context Menu (right-click on agents)

### Phase 4: Goals & Dragons ✅
- [x] Goal Structures (Castle, Tower, Workshop, Campfire, Base)
- [x] Dragon Types (SYNTAX, RUNTIME, NETWORK, PERMISSION, UNKNOWN)
- [x] Combat mechanics
- [x] Error → Dragon spawn flow

### Phase 5: Polish (In Progress)
- [ ] Character models/skins
- [ ] Persistent world state
- [ ] Save/load functionality
- [ ] Tutorial system
- [ ] Sound effects

## Project Structure

```
apps/agents-of-empire/
├── src/
│   ├── core/
│   │   ├── Game.ts                 # Main game loop
│   │   ├── CameraController.ts     # RTS-style camera
│   │   └── SelectionSystem.ts      # Click/drag selection
│   ├── world/
│   │   ├── WorldManager.ts         # Terrain, pathfinding
│   │   └── Terrain.ts              # Procedural generation
│   ├── entities/
│   │   ├── GameAgent.tsx           # Agent visualization
│   │   ├── AgentPool.ts            # Agent spawning
│   │   ├── Dragon.tsx              # Enemy dragons
│   │   └── Structure.tsx           # Buildings
│   ├── ui/
│   │   └── HUD.tsx                 # UI panels
│   ├── bridge/
│   │   └── AgentBridge.ts          # Deep Agents integration
│   ├── landing/
│   │   └── Landing.tsx             # Marketing landing page
│   ├── store/
│   │   └── gameStore.ts            # Zustand state
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css
├── public/
├── package.json
├── vite.config.ts
├── tsconfig.json
└── tailwind.config.js
```

## License

MIT

## Credits

Inspired by [ralv.ai](https://ralv.ai/) and [Ido Salomon's RTS interface](https://x.com/idosal1/status/2014748619480371707).

Built with [LangGraph Deep Agents](https://github.com/langchain-ai/deepagentsjs).
