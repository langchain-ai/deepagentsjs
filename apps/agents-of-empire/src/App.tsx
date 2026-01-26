import React, { Suspense, useCallback, useEffect, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Stars, Environment } from "@react-three/drei";
import { useGame, useGameTime, useGameStats } from "./core/Game";
import { CameraController } from "./core/CameraController";
import { SelectionSystem } from "./core/SelectionSystem";
import { WorldGrid, GroundPlane } from "./world/WorldManager";
import { Terrain } from "./world/Terrain";
import { InitialAgents, useAgentPool } from "./entities/AgentPool";
import { AgentPool } from "./entities/GameAgent";
import { DragonPool } from "./entities/Dragon";
import { StructurePool } from "./entities/Structure";
import { HUD } from "./ui/HUD";
import { useGameStore } from "./store/gameStore";
import Landing from "./landing/Landing";

// ============================================================================
// Game Initialization (runs outside Canvas)
// ============================================================================()

interface GameInitializerProps {
  onReady: () => void;
}

function GameInitializer({ onReady }: GameInitializerProps) {
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

    onReady();
  }, [onReady]);

  return null;
}

// ============================================================================
// Lighting Component
// ============================================================================()

function Lighting() {
  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight
        position={[30, 50, 30]}
        intensity={1}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-far={100}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
      />
      <directionalLight position={[-20, 30, -20]} intensity={0.3} />
      <pointLight position={[0, 20, 0]} intensity={0.2} color="#f4d03f" />
    </>
  );
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
  const { spawnAgent, spawnAgentBatch } = useAgentPool();
  const isDragging = useGameStore((state) => state.isDragging);
  const dragStart = useGameStore((state) => state.dragStart);
  const dragEnd = useGameStore((state) => state.dragEnd);

  // Handle ground click for movement
  const handleGroundClick = useCallback(
    (position: [number, number, number]) => {
      const selectedAgents = useGameStore.getState().selectedAgentIds;

      if (selectedAgents.size === 0) return;

      // Move all selected agents to target
      const targets: [number, number, number][] = [];
      const count = selectedAgents.size;

      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        const radius = Math.max(1, Math.sqrt(count) * 0.5);
        targets.push([
          position[0] + Math.cos(angle) * radius,
          position[1],
          position[2] + Math.sin(angle) * radius,
        ]);
      }

      let i = 0;
      for (const agentId of selectedAgents) {
        useGameStore.getState().updateAgent(agentId, {
          targetPosition: targets[i],
          state: "MOVING",
          currentTask: "Moving...",
        });
        i++;
      }
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

      <InitialAgents count={5} />
      <AgentPool onAgentClick={(agentId) => console.log("Agent clicked:", agentId)} />

      <DragonPool />
      <StructurePool />

      <SelectionSystem
        onAgentsSelected={(ids) => console.log("Selected:", ids)}
        onGroundClicked={handleGroundClick}
      />
    </>
  );
}

// ============================================================================
// Selection Box Overlay
// ============================================================================()

function SelectionBoxOverlay() {
  const isDragging = useGameStore((state) => state.isDragging);
  const dragStart = useGameStore((state) => state.dragStart);
  const dragEnd = useGameStore((state) => state.dragEnd);

  if (!isDragging || !dragStart || !dragEnd) return null;

  const x = Math.min(dragStart.x, dragEnd.x);
  const y = Math.min(dragStart.y, dragEnd.y);
  const width = Math.abs(dragEnd.x - dragStart.x);
  const height = Math.abs(dragEnd.y - dragStart.y);

  return (
    <div
      className="selection-box"
      style={{
        left: x,
        top: y,
        width,
        height,
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
        {/* Initialize game state before Canvas */}
        {!isReady && <GameInitializer onReady={() => setIsReady(true)} />}

        {/* Show loading until ready */}
        {!isReady ? (
          <LoadingScreen />
        ) : (
          <>
            <Canvas
              shadows
              camera={{ position: [40, 40, 40], fov: 50 }}
              gl={{ antialias: true, alpha: false }}
            >
              <GameScene />
              <CameraController />
              <GameLoop /> {/* Game loop runs inside Canvas */}
            </Canvas>

            <HUD />
            <SelectionBoxOverlay />
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
