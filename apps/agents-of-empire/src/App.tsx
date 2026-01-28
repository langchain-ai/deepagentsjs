import { Suspense, useCallback, useEffect, useState, useRef } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Stars, Environment } from "@react-three/drei";
import { useGame } from "./core/Game";
import { CameraController } from "./core/CameraController";
import { SelectionSystem } from "./core/SelectionSystem";
import { WorldGrid, GroundPlane } from "./world/WorldManager";
import { type Structure } from "./store/gameStore";
import { Terrain } from "./world/Terrain";
import { InitialAgents, useAgentPool } from "./entities/AgentPool";
import { AgentPool } from "./entities/GameAgent";
import { DragonPool } from "./entities/Dragon";
import { StructurePool } from "./entities/Structure";
import { ConnectionLines, ConnectionLegend } from "./entities/ConnectionLines";
import { HUD } from "./ui/HUD";
import { useGameStore } from "./store/gameStore";
import Landing from "./landing/Landing";

// ============================================================================
// Game Initialization (runs outside Canvas)
// ============================================================================

interface GameInitializerProps {
  onReady: () => void;
}

function GameInitializer({ onReady }: GameInitializerProps) {
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

    onReady();
  }, [onReady]);

  return null;
}

// ============================================================================
// Lighting Component
// ============================================================================

function Lighting() {
  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight
        position={[30, 50, 30]}
        intensity={1}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-far={100}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
        shadow-bias={-0.0001}
      />
      <directionalLight position={[-20, 30, -20]} intensity={0.3} />
      <pointLight position={[0, 20, 0]} intensity={0.2} color="#f4d03f" distance={50} />
    </>
  );
}

// ============================================================================
// WebGL Context Loss Handler
// ============================================================================()

function ContextLossHandler() {
  const gl = useThree((state) => state.gl);
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const handleContextLoss = (event: Event) => {
      event.preventDefault();
      console.warn("[WebGL] Context lost - attempting recovery...");
    };

    const handleContextRestored = () => {
      console.log("[WebGL] Context restored - forcing re-render");
      forceUpdate((prev) => prev + 1);
    };

    const canvas = gl.domElement;
    canvas.addEventListener("webglcontextlost", handleContextLoss);
    canvas.addEventListener("webglcontextrestored", handleContextRestored);

    return () => {
      canvas.removeEventListener("webglcontextlost", handleContextLoss);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
    };
  }, [gl]);

  return null;
}

// ============================================================================
// Game Loop Component (runs inside Canvas)
// ============================================================================()

function GameLoop() {
  useGame(); // This must be inside Canvas
  return null;
}

// ============================================================================
// Game Scene Component (runs inside Canvas)
// ============================================================================()

function GameScene() {
  useAgentPool();

  // Move agents to a target position in formation
  const moveAgentsToPosition = useCallback(
    (targetPosition: [number, number, number], agentIds: string[]) => {
      if (agentIds.length === 0) return;

      const targets: [number, number, number][] = [];
      const count = agentIds.length;

      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        const radius = Math.max(1, Math.sqrt(count) * 0.5);
        targets.push([
          targetPosition[0] + Math.cos(angle) * radius,
          targetPosition[1],
          targetPosition[2] + Math.sin(angle) * radius,
        ]);
      }

      let i = 0;
      for (const agentId of agentIds) {
        useGameStore.getState().updateAgent(agentId, {
          targetPosition: targets[i],
          state: "MOVING",
          currentTask: `Moving to ${targetPosition[0]}, ${targetPosition[2]}...`,
        });
        i++;
      }
    },
    []
  );

  // Handle ground click for movement
  const handleGroundClick = useCallback(
    (position: [number, number, number]) => {
      const selectedAgents = Array.from(useGameStore.getState().selectedAgentIds);
      if (selectedAgents.length === 0) return;
      moveAgentsToPosition(position, selectedAgents);
    },
    [moveAgentsToPosition]
  );

  // Handle structure click (select structure or show info)
  const handleStructureClick = useCallback(
    (_structureId: string, structure: Structure) => {
      console.log("Structure clicked:", structure.name);
      // Could show structure info panel here
    },
    []
  );

  // Handle structure right-click - assign selected agents to goal
  const handleStructureRightClick = useCallback(
    (_structureId: string, structure: Structure) => {
      const selectedAgents = Array.from(useGameStore.getState().selectedAgentIds);

      if (selectedAgents.length === 0) {
        console.log("No agents selected to assign to", structure.name);
        return;
      }

      console.log(`Assigning ${selectedAgents.length} agents to ${structure.name}`);

      // Move agents to the structure's position
      moveAgentsToPosition(structure.position, selectedAgents);

      // If the structure has a goalId, assign the quest to the agents
      if (structure.goalId) {
        useGameStore.getState().assignQuestToAgents(structure.goalId, selectedAgents);
        console.log(`Assigned quest ${structure.goalId} to ${selectedAgents.length} agents`);
      }

      // Update agent tasks to reflect assignment to this goal
      for (const agentId of selectedAgents) {
        useGameStore.getState().updateAgent(agentId, {
          currentTask: `Assigned to ${structure.name}`,
        });
      }
    },
    [moveAgentsToPosition]
  );

  // Handle structure hover
  const handleStructureHovered = useCallback(
    (_structureId: string | null) => {
      // Could show tooltip or status here
    },
    []
  );

  return (
    <>
      <Lighting />
      <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
      <Environment preset="sunset" />

      <Terrain />
      <WorldGrid />
      <GroundPlane />

      <InitialAgents count={10} />
      <AgentPool onAgentClick={(agentId) => console.log("Agent clicked:", agentId)} />

      <ConnectionLines enabled={true} maxConnections={100} />

      <DragonPool />
      <StructurePool
        onStructureClick={handleStructureClick}
        onStructureRightClick={handleStructureRightClick}
      />

      <SelectionSystem
        onAgentsSelected={(ids) => console.log("Selected:", ids)}
        onGroundClicked={handleGroundClick}
        onStructureClicked={handleStructureClick}
        onStructureRightClicked={handleStructureRightClick}
        onStructureHovered={handleStructureHovered}
      />
    </>
  );
}

// ============================================================================
// Selection Box Overlay
// ============================================================================()

function SelectionBoxOverlay() {
  const selectionBox = useGameStore((state) => state.selectionBox);

  if (!selectionBox || !selectionBox.active) return null;

  const x = Math.min(selectionBox.startX, selectionBox.endX);
  const y = Math.min(selectionBox.startY, selectionBox.endY);
  const width = Math.abs(selectionBox.endX - selectionBox.startX);
  const height = Math.abs(selectionBox.endY - selectionBox.startY);

  // Don't render if box is too small (less than 5 pixels)
  if (width < 5 && height < 5) return null;

  return (
    <div
      className="selection-box"
      style={{
        left: x,
        top: y,
        width,
        height,
        pointerEvents: "none",
      }}
    />
  );
}

// ============================================================================
// Loading Screen
// ============================================================================()

function LoadingScreen() {
  return (
    <div className="fixed inset-0 bg-gradient-to-br from-gray-900 via-empire-dark to-black flex items-center justify-center">
      <div className="text-center">
        <div className="text-8xl mb-6 animate-bounce">⚔️</div>
        <h1 className="text-5xl font-bold text-empire-gold mb-4">Agents of Empire</h1>
        <p className="text-xl text-gray-400">Loading the battlefield...</p>
        <div className="mt-8 w-64 h-2 bg-gray-800 rounded-full overflow-hidden">
          <div className="h-full bg-empire-gold animate-pulse" style={{ width: "66%" }} />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main App Component
// ============================================================================()

export default function App() {
  const [isReady, setIsReady] = useState(false);
  const [showLanding, setShowLanding] = useState(true);

  // Show landing page initially
  if (showLanding) {
    return (
      <Landing
        onEnterGame={() => {
          setShowLanding(false);
        }}
      />
    );
  }

  return (
    <div className="w-screen h-screen overflow-hidden bg-gray-900">
      <Suspense fallback={<LoadingScreen />}>
        {/* Initialize game state before Canvas - only show when not ready */}
        {!isReady ? (
          <>
            <GameInitializer onReady={() => setIsReady(true)} />
            <LoadingScreen />
          </>
        ) : (
          <>
            <Canvas
              shadows
              camera={{ position: [0, 30, 0], fov: 50 }}
              gl={{
                antialias: true,
                alpha: false,
                powerPreference: "high-performance",
                failIfMajorPerformanceCaveat: false,
                preserveDrawingBuffer: false,
                desynchronized: true,
                stencil: false,
                depth: true,
              }}
              dpr={[1, 2]} // Limit pixel ratio for performance
              frameloop="demand" // Only render when needed
            >
              <GameScene />
              <CameraController />
              <GameLoop /> {/* Game loop runs inside Canvas */}
              <ContextLossHandler />
            </Canvas>

            <HUD />
            <SelectionBoxOverlay />
            <ConnectionLegend position="top-right" />
          </>
        )}
      </Suspense>
    </div>
  );
}

// ============================================================================
// Title Screen Component (for future use)
// ============================================================================()

export function TitleScreen({ onStart }: { onStart: () => void }) {
  return (
    <div className="fixed inset-0 bg-gradient-to-br from-gray-900 via-empire-dark to-black flex items-center justify-center">
      <div className="text-center">
        <div className="text-9xl mb-6">⚔️</div>
        <h1 className="text-6xl font-bold text-empire-gold mb-4">Agents of Empire</h1>
        <p className="text-xl text-gray-400 mb-8">Command Your AI Army</p>

        <div className="space-y-4">
          <button
            onClick={onStart}
            className="px-8 py-4 bg-empire-gold text-gray-900 text-xl font-bold rounded-lg hover:bg-yellow-500 transition-colors"
          >
            Start Campaign
          </button>
          <div className="text-gray-500">
            <p>Drag-select agents • Right-click to command • Battle the TypeScript Dragons</p>
          </div>
        </div>

        <div className="mt-12 text-gray-600 text-sm">
          <p>A 3D RTS interface for LangGraph Deep Agents</p>
        </div>
      </div>
    </div>
  );
}
