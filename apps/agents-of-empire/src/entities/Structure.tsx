import React, { useRef, useMemo, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Group, Color } from "three";
import { Text } from "@react-three/drei";
import { useGameStore, useStructuresShallow, type Structure as StructureType } from "../store/gameStore";
import { shallow } from "zustand/shallow";

// ============================================================================
// Structure Visual Configurations
// ============================================================================

const STRUCTURE_CONFIG = {
  castle: {
    color: "#f39c12",
    emissive: "#b7950b",
    scale: 3,
  },
  tower: {
    color: "#e67e22",
    emissive: "#d35400",
    scale: 2,
  },
  workshop: {
    color: "#95a5a6",
    emissive: "#7f8c8d",
    scale: 1.5,
  },
  campfire: {
    color: "#e74c3c",
    emissive: "#c0392b",
    scale: 0.8,
  },
  base: {
    color: "#3498db",
    emissive: "#2980b9",
    scale: 2.5,
  },
};

// ============================================================================
// Structure Visual Component
// ============================================================================

interface StructureVisualProps {
  structure: StructureType;
  isHovered?: boolean;
  hasSelectedAgents?: boolean;
  onPointerOver?: () => void;
  onPointerOut?: () => void;
  onClick?: () => void;
}

export function StructureVisual({
  structure,
  isHovered = false,
  hasSelectedAgents = false,
  onPointerOver,
  onPointerOut,
  onClick,
}: StructureVisualProps) {
  const groupRef = useRef<Group>(null);
  const config = STRUCTURE_CONFIG[structure.type];
  const [pulseScale, setPulseScale] = useState(1);

  // Animate certain structures
  useFrame((state) => {
    if (!groupRef.current) return;

    const time = state.clock.elapsedTime;

    if (structure.type === "campfire") {
      // Flicker effect
      groupRef.current.children[0]?.scale.setScalar(1 + Math.sin(time * 10) * 0.1);
    }

    if (structure.type === "castle" || structure.type === "tower") {
      // Subtle floating for magical structures
      groupRef.current.position.y = Math.sin(time * 0.5) * 0.1;
    }

    // Pulse effect when hovered with selected agents
    if (hasSelectedAgents && isHovered) {
      setPulseScale(1 + Math.sin(time * 4) * 0.1);
    } else {
      setPulseScale(1);
    }
  });

  // Structure radius based on type for click detection
  const STRUCTURE_RADIUS: Record<string, number> = {
    castle: 4,
    tower: 3,
    workshop: 2.5,
    campfire: 1.5,
    base: 4,
  };

  const radius = STRUCTURE_RADIUS[structure.type] || 3;

  return (
<<<<<<< HEAD
    <group ref={groupRef} position={structure.position}>
      {/* Structure base - render different geometry based on type */}
      {structure.type === "castle" && <CastleMesh />}
      {structure.type === "tower" && <TowerMesh />}
      {structure.type === "workshop" && <WorkshopMesh />}
      {structure.type === "campfire" && <CampfireMesh />}
      {structure.type === "base" && <BaseMesh />}
=======
    <group
      ref={groupRef}
      position={structure.position}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
      onClick={onClick}
    >
      {/* Invisible hit sphere for easier clicking */}
      <mesh visible={false}>
        <sphereGeometry args={[radius, 16, 16]} />
        <meshBasicMaterial />
      </mesh>
>>>>>>> origin/main

      {/* Highlight ring when hovered with selected agents */}
      {hasSelectedAgents && isHovered && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.1, 0]}>
          <ringGeometry args={[radius, radius + 0.3, 32]} />
          <meshBasicMaterial color="#2ecc71" transparent opacity={0.6} />
        </mesh>
      )}

      {/* Highlight ring when hovered without selected agents */}
      {isHovered && !hasSelectedAgents && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.1, 0]}>
          <ringGeometry args={[radius, radius + 0.2, 32]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.4} />
        </mesh>
      )}

      {/* Scale pulse for hover effect */}
      <group scale={pulseScale}>
        {/* Structure base - render different geometry based on type */}
        {structure.type === "castle" && <CastleMesh />}
        {structure.type === "tower" && <TowerMesh />}
        {structure.type === "workshop" && <WorkshopMesh />}
        {structure.type === "campfire" && <CampfireMesh />}
        {structure.type === "base" && <BaseMesh />}
      </group>

      {/* Name label */}
      <Text
        position={[0, 3, 0]}
        fontSize={0.3}
        color="#f4d03f"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.02}
        outlineColor="#000000"
      >
        {structure.name}
      </Text>

      {/* Assignment indicator when agents can be assigned */}
      {hasSelectedAgents && !isHovered && (
        <Text
          position={[0, 3.7, 0]}
          fontSize={0.2}
          color="#2ecc71"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.02}
          outlineColor="#000000"
        >
          Right-click to assign
        </Text>
      )}

      {/* Goal indicator if this is a quest target */}
      {structure.goalId && (
        <group position={[0, 4, 0]}>
          <mesh>
            <sphereGeometry args={[0.3, 8, 8]} />
            <meshBasicMaterial color="#f4d03f" />
          </mesh>
          <pointLight color="#f4d03f" intensity={2} distance={5} />
        </group>
      )}
    </group>
  );
}

// ============================================================================
// Structure Mesh Components
// ============================================================================

function CastleMesh() {
  const config = STRUCTURE_CONFIG.castle;

  return (
    <group>
      {/* Main keep */}
      <mesh castShadow receiveShadow position={[0, 2, 0]}>
        <boxGeometry args={[3, 4, 3]} />
        <meshStandardMaterial color={config.color} emissive={config.emissive} emissiveIntensity={0.3} />
      </mesh>
      {/* Towers at corners */}
      {[[-1.5, 2, -1.5], [1.5, 2, -1.5], [-1.5, 2, 1.5], [1.5, 2, 1.5]].map((pos, i) => (
        <mesh key={i} position={pos} castShadow>
          <cylinderGeometry args={[0.5, 0.5, 3, 8]} />
          <meshStandardMaterial color={config.color} emissive={config.emissive} emissiveIntensity={0.3} />
        </mesh>
      ))}
    </group>
  );
}

function TowerMesh() {
  const config = STRUCTURE_CONFIG.tower;

  return (
    <group>
      {/* Main tower */}
      <mesh castShadow receiveShadow position={[0, 2, 0]}>
        <cylinderGeometry args={[1, 1.2, 4, 8]} />
        <meshStandardMaterial color={config.color} emissive={config.emissive} emissiveIntensity={0.3} />
      </mesh>
      {/* Cone roof */}
      <mesh position={[0, 4.5, 0]} castShadow>
        <coneGeometry args={[1.5, 2, 8]} />
        <meshStandardMaterial color="#8b4513" />
      </mesh>
    </group>
  );
}

function WorkshopMesh() {
  const config = STRUCTURE_CONFIG.workshop;

  return (
    <group>
      {/* Main building */}
      <mesh castShadow receiveShadow position={[0, 1, 0]}>
        <boxGeometry args={[2, 2, 2]} />
        <meshStandardMaterial color={config.color} emissive={config.emissive} emissiveIntensity={0.3} />
      </mesh>
      {/* Roof */}
      <mesh position={[0, 2.2, 0]} castShadow>
        <coneGeometry args={[1.8, 1, 4]} />
        <meshStandardMaterial color="#8b4513" />
      </mesh>
      {/* Chimney */}
      <mesh position={[0.5, 2.5, 0.5]} castShadow>
        <cylinderGeometry args={[0.2, 0.2, 0.8, 8]} />
        <meshStandardMaterial color="#7f8c8d" />
      </mesh>
    </group>
  );
}

function CampfireMesh() {
  const config = STRUCTURE_CONFIG.campfire;

  return (
    <group>
      {/* Fire pit */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.1, 0]} receiveShadow>
        <ringGeometry args={[0.3, 0.5, 16]} />
        <meshStandardMaterial color="#5d4037" />
      </mesh>
      {/* Fire */}
      <mesh position={[0, 0.5, 0]}>
        <coneGeometry args={[0.3, 0.8, 8]} />
        <meshBasicMaterial color="#e74c3c" />
      </mesh>
      {/* Light */}
      <pointLight color="#e74c3c" intensity={2} distance={5} position={[0, 0.5, 0]} />
    </group>
  );
}

function BaseMesh() {
  const config = STRUCTURE_CONFIG.base;

  return (
    <group>
      {/* Main building */}
      <mesh castShadow receiveShadow position={[0, 1, 0]}>
        <boxGeometry args={[3, 2, 3]} />
        <meshStandardMaterial color={config.color} emissive={config.emissive} emissiveIntensity={0.3} />
      </mesh>
      {/* Flag pole */}
      <mesh position={[0, 2.5, 0]} castShadow>
        <cylinderGeometry args={[0.1, 0.1, 2, 8]} />
        <meshStandardMaterial color="#8b4513" />
      </mesh>
      {/* Flag */}
      <mesh position={[0.3, 4, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[0.8, 0.5]} />
        <meshBasicMaterial color="#f4d03f" side={2} />
      </mesh>
    </group>
  );
}

// ============================================================================
// Structure Pool Component
// ============================================================================

interface StructurePoolProps {
  onStructureClick?: (structureId: string, structure: StructureType) => void;
  onStructureRightClick?: (structureId: string, structure: StructureType) => void;
}

export function StructurePool({ onStructureClick, onStructureRightClick }: StructurePoolProps) {
  const structuresMap = useStructuresShallow() as Record<string, StructureType>;
  const structures = useMemo(() => Object.values(structuresMap), [structuresMap]);
  const hoverStructureId = useGameStore((state) => state.hoverStructureId);
  const selectedAgentIds = useGameStore((state) => state.selectedAgentIds);
  const setHoveredStructure = useGameStore((state) => state.setHoveredStructure);

  // Handle structure hover
  const handleStructureHover = useCallback((structureId: string | null) => {
    setHoveredStructure(structureId);
  }, [setHoveredStructure]);

  // Check if there are selected agents (for assignment UI)
  const hasSelectedAgents = selectedAgentIds.size > 0;

  return (
    <>
      {structures.map((structure) => (
        <StructureVisual
          key={structure.id}
          structure={structure}
          isHovered={hoverStructureId === structure.id}
          hasSelectedAgents={hasSelectedAgents}
          onPointerOver={() => handleStructureHover(structure.id)}
          onPointerOut={() => handleStructureHover(null)}
          onClick={() => onStructureClick?.(structure.id, structure)}
        />
      ))}
    </>
  );
}

// ============================================================================
// Structure Spawn Effect
// ============================================================================

interface StructureSpawnEffectProps {
  position: [number, number, number];
  type: StructureType["type"];
  onComplete?: () => void;
}

export function StructureSpawnEffect({ position, type, onComplete }: StructureSpawnEffectProps) {
  const groupRef = useRef<Group>(null);
  const [progress, setProgress] = useState(0);
  const config = STRUCTURE_CONFIG[type];

  useFrame((state) => {
    if (!groupRef.current) return;

    setProgress((p) => Math.min(p + 0.02, 1));

    if (progress >= 1) {
      onComplete?.();
    }
  });

  if (progress >= 1) return null;

  return (
    <group ref={groupRef} position={position}>
      {/* Rising effect */}
      <mesh position={[0, progress * 2, 0]}>
        <boxGeometry args={[config.scale * progress, config.scale * progress, config.scale * progress]} />
        <meshStandardMaterial
          color={config.color}
          emissive={config.emissive}
          transparent
          opacity={1 - progress * 0.5}
        />
      </mesh>

      {/* Particles */}
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
        const angle = (i / 8) * Math.PI * 2;
        const radius = progress * config.scale;
        return (
          <mesh
            key={i}
            position={[
              Math.cos(angle) * radius,
              progress * 3,
              Math.sin(angle) * radius,
            ]}
          >
            <sphereGeometry args={[0.1, 4, 4]} />
            <meshBasicMaterial color={config.color} />
          </mesh>
        );
      })}
    </group>
  );
}

// ============================================================================
// Export types
// ============================================================================

export type { StructureVisualProps };
