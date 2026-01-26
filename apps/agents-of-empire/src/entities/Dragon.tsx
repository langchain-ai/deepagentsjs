import { useRef, useMemo, useCallback, useState, useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import { Group, Vector3, Color } from "three";
import { Text } from "@react-three/drei";
import { useGameStore, useAgentsShallow, useDragonsShallow, type GameAgent, type Dragon as DragonType } from "../store/gameStore";

// ============================================================================
// Dragon Types Configuration
// ============================================================================

const DRAGON_CONFIG = {
  SYNTAX: {
    color: "#e74c3c", // Red
    emissive: "#c0392b",
    size: 2,
    attackType: "fire",
  },
  RUNTIME: {
    color: "#9b59b6", // Purple
    emissive: "#6c3483",
    size: 2.5,
    attackType: "magic",
  },
  NETWORK: {
    color: "#3498db", // Blue
    emissive: "#1a5276",
    size: 2.2,
    attackType: "lightning",
  },
  PERMISSION: {
    color: "#27ae60", // Green
    emissive: "#1e8449",
    size: 1.8,
    attackType: "poison",
  },
  UNKNOWN: {
    color: "#2c3e50", // Black/Dark
    emissive: "#1a1a2e",
    size: 3,
    attackType: "shadow",
  },
};

// ============================================================================
// Dragon Visual Component
// ============================================================================

interface DragonVisualProps {
  dragon: DragonType;
  onDefeated?: (dragonId: string) => void;
}

export function DragonVisual({ dragon, onDefeated }: DragonVisualProps) {
  const groupRef = useRef<Group>(null);
  const bodyRef = useRef<Group>(null);
  const particlesRef = useRef<Group>(null);

  const config = DRAGON_CONFIG[dragon.type];
  const healthPercent = dragon.health / dragon.maxHealth;

  // Animate dragon
  useFrame((state) => {
    if (!groupRef.current || !bodyRef.current) return;

    const time = state.clock.elapsedTime;

    // Hovering animation
    groupRef.current.position.y = Math.sin(time * 2) * 0.3 + 2;

    // Breathing animation
    const breathe = 1 + Math.sin(time * 3) * 0.1;
    bodyRef.current.scale.setScalar(breathe);

    // Slow rotation
    bodyRef.current.rotation.y = Math.sin(time * 0.5) * 0.2;

    // Particle effects based on type
    if (particlesRef.current) {
      // Could add particle system here
    }
  });

  // Get dragon geometry based on type
  const renderDragonBody = () => {
    switch (dragon.type) {
      case "SYNTAX":
        return <SyntaxDragonBody />;
      case "RUNTIME":
        return <RuntimeDragonBody />;
      case "NETWORK":
        return <NetworkDragonBody />;
      case "PERMISSION":
        return <PermissionDragonBody />;
      default:
        return <UnknownDragonBody />;
    }
  };

  return (
    <group ref={groupRef} position={dragon.position}>
      {/* Shadow on ground */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.8, 0]}>
        <circleGeometry args={[config.size * 0.8, 16]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.3} />
      </mesh>

      {/* Dragon body */}
      <group ref={bodyRef}>{renderDragonBody()}</group>

      {/* Health bar */}
      <group position={[0, 4, 0]}>
        {/* Background */}
        <mesh position={[0, 0, 0]}>
          <planeGeometry args={[3, 0.3]} />
          <meshBasicMaterial color="#333333" />
        </mesh>
        {/* Health */}
        <mesh position={[-(3 - 3 * healthPercent) / 2, 0, 0.01]}>
          <planeGeometry args={[3 * healthPercent, 0.3]} />
          <meshBasicMaterial
            color={healthPercent > 0.5 ? "#27ae60" : healthPercent > 0.25 ? "#f39c12" : "#e74c3c"}
          />
        </mesh>
      </group>

      {/* Error message */}
      <Text
        position={[0, 5, 0]}
        fontSize={0.3}
        color="#e74c3c"
        anchorX="center"
        anchorY="middle"
        maxWidth={5}
      >
        {dragon.error.slice(0, 30)}{dragon.error.length > 30 ? "..." : ""}
      </Text>

      {/* Dragon type label */}
      <Text
        position={[0, -2.5, 0]}
        fontSize={0.2}
        color={config.color}
        anchorX="center"
        anchorY="middle"
      >
        {dragon.type} DRAGON
      </Text>
    </group>
  );
}

// ============================================================================
// Dragon Body Variants
// ============================================================================

function SyntaxDragonBody() {
  const color = DRAGON_CONFIG.SYNTAX.color;
  const emissive = DRAGON_CONFIG.SYNTAX.emissive;

  return (
    <group>
      {/* Body */}
      <mesh castShadow position={[0, 0, 0]}>
        <boxGeometry args={[1.5, 1, 2]} />
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.5} />
      </mesh>

      {/* Head */}
      <mesh castShadow position={[0, 0.8, 1.2]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.5} />
      </mesh>

      {/* Wings */}
      <mesh castShadow position={[-1.2, 0.5, 0]} rotation={[0, 0, 0.3]}>
        <boxGeometry args={[1.5, 0.1, 1.5]} />
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.5} />
      </mesh>
      <mesh castShadow position={[1.2, 0.5, 0]} rotation={[0, 0, -0.3]}>
        <boxGeometry args={[1.5, 0.1, 1.5]} />
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.5} />
      </mesh>

      {/* Tail */}
      <mesh castShadow position={[0, -0.2, -1.5]}>
        <coneGeometry args={[0.3, 1.5, 4]} />
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.5} />
      </mesh>

      {/* Fire particles */}
      <pointLight color="#ff6600" intensity={2} distance={5} position={[0, 1, 1.5]} />
    </group>
  );
}

function RuntimeDragonBody() {
  const color = DRAGON_CONFIG.RUNTIME.color;
  const emissive = DRAGON_CONFIG.RUNTIME.emissive;

  return (
    <group>
      {/* Body - sphere for magical creature */}
      <mesh castShadow position={[0, 0, 0]}>
        <sphereGeometry args={[1.2, 16, 16]} />
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.6} transparent opacity={0.9} />
      </mesh>

      {/* Eyes */}
      <mesh position={[-0.4, 0.3, 1]}>
        <sphereGeometry args={[0.15, 8, 8]} />
        <meshBasicMaterial color="#ff00ff" />
      </mesh>
      <mesh position={[0.4, 0.3, 1]}>
        <sphereGeometry args={[0.15, 8, 8]} />
        <meshBasicMaterial color="#ff00ff" />
      </mesh>

      {/* Crystal horns */}
      <mesh position={[-0.5, 0.8, 0]} rotation={[0.3, 0, 0.3]}>
        <coneGeometry args={[0.15, 0.8, 4]} />
        <meshStandardMaterial color="#e056fd" emissive="#e056fd" emissiveIntensity={0.8} />
      </mesh>
      <mesh position={[0.5, 0.8, 0]} rotation={[0.3, 0, -0.3]}>
        <coneGeometry args={[0.15, 0.8, 4]} />
        <meshStandardMaterial color="#e056fd" emissive="#e056fd" emissiveIntensity={0.8} />
      </mesh>

      {/* Magic aura */}
      <pointLight color="#9b59b6" intensity={3} distance={6} position={[0, 0, 0]} />
    </group>
  );
}

function NetworkDragonBody() {
  const color = DRAGON_CONFIG.NETWORK.color;
  const emissive = DRAGON_CONFIG.NETWORK.emissive;

  return (
    <group>
      {/* Body - angular/tech-like */}
      <mesh castShadow position={[0, 0, 0]}>
        <octahedronGeometry args={[1.2, 0]} />
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.5} wireframe />
      </mesh>

      {/* Inner core */}
      <mesh position={[0, 0, 0]}>
        <octahedronGeometry args={[0.6, 0]} />
        <meshStandardMaterial color="#00ffff" emissive="#00ffff" emissiveIntensity={0.8} />
      </mesh>

      {/* Electric arcs (simplified as lines) */}
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[Math.cos(i * 2) * 1.5, Math.sin(i * 2) * 0.5, 0]} rotation={[Math.random(), Math.random(), Math.random()]}>
          <cylinderGeometry args={[0.02, 0.02, 2]} />
          <meshBasicMaterial color="#00ffff" />
        </mesh>
      ))}

      {/* Lightning effect */}
      <pointLight color="#00ffff" intensity={2} distance={5} position={[0, 0, 0]} />
    </group>
  );
}

function PermissionDragonBody() {
  const color = DRAGON_CONFIG.PERMISSION.color;
  const emissive = DRAGON_CONFIG.PERMISSION.emissive;

  return (
    <group>
      {/* Body - snake-like */}
      <mesh castShadow position={[0, 0, 0]}>
        <cylinderGeometry args={[0.5, 0.3, 2, 8]} />
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.4} />
      </mesh>

      {/* Head */}
      <mesh castShadow position={[0, 0.3, 1.2]}>
        <coneGeometry args={[0.4, 0.8, 8]} />
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.4} />
      </mesh>

      {/* Hood */}
      <mesh position={[0, 0.5, 0.8]}>
        <sphereGeometry args={[0.8, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.4} transparent opacity={0.7} />
      </mesh>

      {/* Poison drip particles */}
      <pointLight color="#27ae60" intensity={1} distance={3} position={[0, 0.5, 1.5]} />
    </group>
  );
}

function UnknownDragonBody() {
  const color = DRAGON_CONFIG.UNKNOWN.color;
  const emissive = DRAGON_CONFIG.UNKNOWN.emissive;

  return (
    <group>
      {/* Shadowy form */}
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[2, 2, 2]} />
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.3} transparent opacity={0.8} />
      </mesh>

      {/* Glowing eyes */}
      <mesh position={[-0.5, 0.5, 1]}>
        <sphereGeometry args={[0.2, 8, 8]} />
        <meshBasicMaterial color="#ff0000" />
      </mesh>
      <mesh position={[0.5, 0.5, 1]}>
        <sphereGeometry args={[0.2, 8, 8]} />
        <meshBasicMaterial color="#ff0000" />
      </mesh>

      {/* Shadow tendrils */}
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} position={[Math.cos(i * Math.PI / 2) * 1.5, -0.5, Math.sin(i * Math.PI / 2) * 1.5]}>
          <cylinderGeometry args={[0.1, 0.3, 1.5, 4]} />
          <meshStandardMaterial color="#1a1a2e" emissive="#0d0d1a" emissiveIntensity={0.5} />
        </mesh>
      ))}

      {/* Dark aura */}
      <pointLight color="#000000" intensity={2} distance={4} position={[0, 0, 0]} />
    </group>
  );
}

// ============================================================================
// Dragon Pool Component
// ============================================================================

interface DragonPoolProps {
  onDragonClick?: (dragonId: string) => void;
}

export function DragonPool({ onDragonClick }: DragonPoolProps) {
  const dragonsMap = useDragonsShallow() as Map<string, DragonType>;

  // Convert Map to array with memoization
  const dragons = useMemo(() => Array.from(dragonsMap.values()), [dragonsMap]);

  return (
    <>
      {dragons.map((dragon) => (
        <DragonVisual
          key={dragon.id}
          dragon={dragon}
          onDefeated={onDragonClick}
        />
      ))}
    </>
  );
}

// ============================================================================
// Combat System Hook
// ============================================================================

export function useCombat() {
  const agentsMap = useAgentsShallow() as Map<string, GameAgent>;
  const dragonsMap = useDragonsShallow() as Map<string, DragonType>;
  // Actions are stable references, safe to select individually
  const updateAgent = useGameStore((state) => state.updateAgent);
  const updateDragon = useGameStore((state) => state.updateDragon);
  const damageDragon = useGameStore((state) => state.damageDragon);
  const removeDragon = useGameStore((state) => state.removeDragon);
  const setAgentState = useGameStore((state) => state.setAgentState);

  // Agent attacks dragon
  const attackDragon = useCallback(
    (agentId: string, dragonId: string) => {
      const agent = agentsMap.get(agentId);
      const dragon = dragonsMap.get(dragonId);

      if (!agent || !dragon) return;

      // Calculate damage based on agent level
      const baseDamage = 10 + agent.level * 5;
      const variance = Math.random() * 10 - 5;
      const damage = Math.round(baseDamage + variance);

      // Apply damage
      damageDragon(dragonId, damage);

      // Check if dragon is defeated
      const updatedDragon = useGameStore.getState().dragons.get(dragonId);
      if (updatedDragon && updatedDragon.health <= 0) {
        // Dragon defeated!
        removeDragon(dragonId);
        setAgentState(agentId, "COMPLETING");

        // Grant XP to agent
        updateAgent(agentId, {
          level: agent.level + 1,
          currentTask: "Victory!",
        });

        return { damage, defeated: true };
      }

      // Dragon counter-attacks
      const dragonDamage = Math.round(5 + Math.random() * 10);
      updateAgent(agentId, {
        health: Math.max(0, agent.health - dragonDamage),
      });

      // Check if agent is defeated
      const updatedAgent = useGameStore.getState().agents.get(agentId);
      if (updatedAgent && updatedAgent.health <= 0) {
        setAgentState(agentId, "ERROR");
        updateAgent(agentId, { currentTask: "Defeated..." });
      }

      return { damage, defeated: false, dragonDamage };
    },
    [agentsMap, dragonsMap, damageDragon, removeDragon, setAgentState, updateAgent]
  );

  // Auto-resolve combat (simulated retry logic)
  const autoResolveCombat = useCallback(
    (agentId: string, dragonId: string) => {
      let attempts = 0;
      const maxAttempts = 3;

      const interval = setInterval(() => {
        const result = attackDragon(agentId, dragonId);
        attempts++;

        if (result?.defeated || attempts >= maxAttempts) {
          clearInterval(interval);

          // If dragon defeated after retries
          if (result?.defeated) {
            // Success!
          } else if (attempts >= maxAttempts) {
            // Failed after max attempts - agent retreats
            setAgentState(agentId, "ERROR");
            updateAgent(agentId, { currentTask: "Retreating..." });
          }
        }
      }, 1000);

      return () => clearInterval(interval);
    },
    [attackDragon, setAgentState, updateAgent]
  );

  return {
    attackDragon,
    autoResolveCombat,
  };
}

// ============================================================================
// Dragon Spawn Effect
// ============================================================================

interface DragonSpawnEffectProps {
  position: [number, number, number];
  type: DragonType;
  onComplete?: () => void;
}

export function DragonSpawnEffect({ position, type, onComplete }: DragonSpawnEffectProps) {
  const groupRef = useRef<Group>(null);
  const config = DRAGON_CONFIG[type];
  const [progress, setProgress] = React.useState(0);

  useFrame((state) => {
    if (!groupRef.current) return;

    const delta = 0.02;
    setProgress((p) => Math.min(p + delta, 1));

    if (progress >= 1) {
      onComplete?.();
    }
  });

  if (progress >= 1) return null;

  return (
    <group ref={groupRef} position={position}>
      {/* Summoning circle */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0, progress * 3, 32]} />
        <meshBasicMaterial color={config.color} transparent opacity={1 - progress} />
      </mesh>

      {/* Rising particles */}
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
        const angle = (i / 8) * Math.PI * 2;
        const radius = progress * 2;
        return (
          <mesh key={i} position={[Math.cos(angle) * radius, progress * 3, Math.sin(angle) * radius]}>
            <sphereGeometry args={[0.1, 8, 8]} />
            <meshBasicMaterial color={config.color} />
          </mesh>
        );
      })}
    </group>
  );
}
