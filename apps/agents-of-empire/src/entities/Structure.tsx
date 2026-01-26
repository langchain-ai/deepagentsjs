import { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { Group, Color } from "three";
import { Text } from "@react-three/drei";
import { useGameStore, useStructuresShallow, type Structure as StructureType } from "../store/gameStore";

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
}

export function StructureVisual({ structure }: StructureVisualProps) {
  const groupRef = useRef<Group>(null);
  const config = STRUCTURE_CONFIG[structure.type];

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
  });

  return (
    <group ref={groupRef} position={structure.position}>
      {/* Structure base */}
      <mesh castShadow receiveShadow position={[0, 0.5, 0]}>
        {structure.type === "castle" && <CastleGeometry />}
        {structure.type === "tower" && <TowerGeometry />}
        {structure.type === "workshop" && <WorkshopGeometry />}
        {structure.type === "campfire" && <CampfireGeometry />}
        {structure.type === "base" && <BaseGeometry />}
        <meshStandardMaterial
          color={config.color}
          emissive={config.emissive}
          emissiveIntensity={0.3}
        />
      </mesh>

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
// Structure Geometries
// ============================================================================()

function CastleGeometry() {
  return (
    <group>
      {/* Main keep */}
      <boxGeometry args={[3, 4, 3]} />
      {/* Towers at corners */}
      {[[-1.5, 2, -1.5], [1.5, 2, -1.5], [-1.5, 2, 1.5], [1.5, 2, 1.5]].map((pos, i) => (
        <mesh key={i} position={pos}>
          <cylinderGeometry args={[0.5, 0.5, 3, 8]} />
          <meshStandardMaterial color="#f39c12" />
        </mesh>
      ))}
    </group>
  );
}

function TowerGeometry() {
  return (
    <group>
      {/* Main tower */}
      <cylinderGeometry args={[1, 1.2, 4, 8]} />
      {/* Cone roof */}
      <mesh position={[0, 2.5, 0]}>
        <coneGeometry args={[1.5, 2, 8]} />
        <meshStandardMaterial color="#8b4513" />
      </mesh>
    </group>
  );
}

function WorkshopGeometry() {
  return (
    <group>
      {/* Main building */}
      <boxGeometry args={[2, 2, 2]} />
      {/* Roof */}
      <mesh position={[0, 1.5, 0]}>
        <coneGeometry args={[1.8, 1, 4]} />
        <meshStandardMaterial color="#8b4513" />
      </mesh>
      {/* Chimney */}
      <mesh position={[0.5, 2, 0.5]}>
        <cylinderGeometry args={[0.2, 0.2, 0.8, 8]} />
        <meshStandardMaterial color="#7f8c8d" />
      </mesh>
    </group>
  );
}

function CampfireGeometry() {
  return (
    <group>
      {/* Fire pit */}
      <ringGeometry args={[0.3, 0.5, 16]} />
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

function BaseGeometry() {
  return (
    <group>
      {/* Main building */}
      <boxGeometry args={[3, 2, 3]} />
      {/* Flag pole */}
      <mesh position={[0, 2, 0]}>
        <cylinderGeometry args={[0.1, 0.1, 2, 8]} />
        <meshStandardMaterial color="#8b4513" />
      </mesh>
      {/* Flag */}
      <mesh position={[0.3, 3.5, 0]}>
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
  onStructureClick?: (structureId: string) => void;
}

export function StructurePool({ onStructureClick }: StructurePoolProps) {
  const structuresMap = useStructuresShallow() as Map<string, StructureType>;
  const structures = useMemo(() => Array.from(structuresMap.values()), [structuresMap]);

  return (
    <>
      {structures.map((structure) => (
        <StructureVisual
          key={structure.id}
          structure={structure}
        />
      ))}
    </>
  );
}

// ============================================================================
// Structure Spawn Effect
// ============================================================================()

interface StructureSpawnEffectProps {
  position: [number, number, number];
  type: StructureType["type"];
  onComplete?: () => void;
}

export function StructureSpawnEffect({ position, type, onComplete }: StructureSpawnEffectProps) {
  const groupRef = useRef<Group>(null);
  const [progress, setProgress] = React.useState(0);
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

import React from "react";
