import { useRef, useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { Group, Vector3, Color, Euler } from "three";
import { Text } from "@react-three/drei";
import { useGameStore, type AgentState, type GameAgent as GameAgentType } from "../store/gameStore";

// ============================================================================
// Agent State Visual Configurations
// ============================================================================

const AGENT_STATE_COLORS: Record<AgentState, string> = {
  IDLE: "#3498db",      // Blue
  THINKING: "#9b59b6",  // Purple
  MOVING: "#2ecc71",    // Green
  WORKING: "#f39c12",   // Orange
  ERROR: "#e74c3c",     // Red
  COMPLETING: "#f4d03f", // Gold
  COMBAT: "#e74c3c",    // Red
};

const AGENT_STATE_EMISSIVE: Record<AgentState, string> = {
  IDLE: "#1a5276",
  THINKING: "#6c3483",
  MOVING: "#1e8449",
  WORKING: "#b7950b",
  ERROR: "#c0392b",
  COMPLETING: "#b7950b",
  COMBAT: "#c0392b",
};

// ============================================================================
// Agent State Icons (emojis for now, could be textures)
// ============================================================================

const AGENT_STATE_ICONS: Record<AgentState, string> = {
  IDLE: "💤",
  THINKING: "🤔",
  MOVING: "🏃",
  WORKING: "⚒️",
  ERROR: "❌",
  COMPLETING: "✨",
  COMBAT: "⚔️",
};

// ============================================================================
// Agent Visual Component
// ============================================================================

interface GameAgentVisualProps {
  agent: GameAgentType;
  isSelected: boolean;
  isHovered: boolean;
  onPointerOver: () => void;
  onPointerOut: () => void;
  onClick: () => void;
}

export function GameAgentVisual({
  agent,
  isSelected,
  isHovered,
  onPointerOver,
  onPointerOut,
  onClick,
}: GameAgentVisualProps) {
  const groupRef = useRef<Group>(null);
  const bodyRef = useRef<Group>(null);
  const pulseRef = useRef(0);

  // Color based on state
  const color = useMemo(() => new Color(AGENT_STATE_COLORS[agent.state]), [agent.state]);
  const emissive = useMemo(() => new Color(AGENT_STATE_EMISSIVE[agent.state]), [agent.state]);

  // Movement animation
  useFrame((state) => {
    if (!bodyRef.current) return;

    // Idle/walking animation
    const time = state.clock.elapsedTime;
    const bobAmount = agent.state === "MOVING" ? 0.1 : 0.03;
    const bobSpeed = agent.state === "MOVING" ? 10 : 2;

    bodyRef.current.position.y = Math.sin(time * bobSpeed) * bobAmount;

    // Rotate when moving
    if (agent.targetPosition) {
      const currentPos = new Vector3(...agent.position);
      const targetPos = new Vector3(...agent.targetPosition);
      const direction = targetPos.sub(currentPos).normalize();
      const angle = Math.atan2(direction.x, direction.z);
      bodyRef.current.rotation.y = angle;
    }

    // Pulse effect for thinking state
    if (agent.state === "THINKING") {
      pulseRef.current += 0.05;
      const scale = 1 + Math.sin(pulseRef.current) * 0.1;
      bodyRef.current.scale.setScalar(scale);
    } else {
      bodyRef.current.scale.setScalar(1);
    }

    // Hover effect
    if (isHovered || isSelected) {
      groupRef.current.position.y = Math.sin(time * 3) * 0.2 + 0.5;
    } else {
      groupRef.current.position.y = 0;
    }
  });

  return (
    <group
      ref={groupRef}
      position={agent.position}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
      onClick={onClick}
    >
      {/* Selection ring */}
      {isSelected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.4, 0]}>
          <ringGeometry args={[0.6, 0.7, 32]} />
          <meshBasicMaterial color="#f4d03f" transparent opacity={0.8} />
        </mesh>
      )}

      {/* Hover ring */}
      {isHovered && !isSelected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.4, 0]}>
          <ringGeometry args={[0.6, 0.65, 32]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.5} />
        </mesh>
      )}

      {/* Agent body group */}
      <group ref={bodyRef}>
        {/* Body */}
        <mesh castShadow position={[0, 0.5, 0]}>
          <boxGeometry args={[0.8, 1, 0.5]} />
          <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.3} />
        </mesh>

        {/* Head */}
        <mesh castShadow position={[0, 1.2, 0]}>
          <boxGeometry args={[0.5, 0.5, 0.5]} />
          <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.3} />
        </mesh>

        {/* Arms */}
        <mesh castShadow position={[-0.5, 0.6, 0]}>
          <boxGeometry args={[0.2, 0.6, 0.2]} />
          <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.3} />
        </mesh>
        <mesh castShadow position={[0.5, 0.6, 0]}>
          <boxGeometry args={[0.2, 0.6, 0.2]} />
          <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.3} />
        </mesh>

        {/* Legs */}
        <mesh castShadow position={[-0.2, -0.3, 0]}>
          <boxGeometry args={[0.2, 0.4, 0.2]} />
          <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.3} />
        </mesh>
        <mesh castShadow position={[0.2, -0.3, 0]}>
          <boxGeometry args={[0.2, 0.4, 0.2]} />
          <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.3} />
        </mesh>
      </group>

      {/* Tool indicator */}
      {agent.equippedTool && (
        <mesh position={[0.7, 0.8, 0]}>
          <sphereGeometry args={[0.15, 8, 8]} />
          <meshBasicMaterial color="#f4d03f" />
        </mesh>
      )}

      {/* State icon (floating above) */}
      {(agent.state !== "IDLE" || agent.thoughtBubble) && (
        <Text
          position={[0, 2.2, 0]}
          fontSize={0.5}
          color="#ffffff"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.02}
          outlineColor="#000000"
        >
          {agent.thoughtBubble || AGENT_STATE_ICONS[agent.state]}
        </Text>
      )}

      {/* Agent name */}
      <Text
        position={[0, -0.8, 0]}
        fontSize={0.2}
        color="#f4d03f"
        anchorX="center"
        anchorY="middle"
      >
        {agent.name}
      </Text>

      {/* Level indicator */}
      <Text
        position={[0, -1, 0]}
        fontSize={0.15}
        color="#ffffff"
        anchorX="center"
        anchorY="middle"
      >
        Lv.{agent.level}
      </Text>

      {/* Health bar */}
      {agent.health < agent.maxHealth && (
        <group position={[0, 1.8, 0]}>
          <mesh position={[0, 0, 0]}>
            <planeGeometry args={[1, 0.1]} />
            <meshBasicMaterial color="#333333" />
          </mesh>
          <mesh position={[-(1 - agent.health / agent.maxHealth) / 2, 0, 0.01]}>
            <planeGeometry args={[agent.health / agent.maxHealth, 0.1]} />
            <meshBasicMaterial color={agent.health > 30 ? "#27ae60" : "#e74c3c"} />
          </mesh>
        </group>
      )}

      {/* Connection line to parent (for subagents) */}
      {agent.parentId && null /* Rendered separately in pool */}
    </group>
  );
}

// ============================================================================
// Agent Movement Hook
// ============================================================================

export function useAgentMovement(agentId: string) {
  const agent = useGameStore((state) => state.agents.get(agentId));
  const updateAgent = useGameStore((state) => state.updateAgent);
  const setAgentPosition = useGameStore((state) => state.setAgentPosition);

  useEffect(() => {
    if (!agent || !agent.targetPosition) return;

    const speed = 3; // units per second
    const currentPos = new Vector3(...agent.position);
    const targetPos = new Vector3(...agent.targetPosition);
    const direction = targetPos.clone().sub(currentPos);
    const distance = direction.length();

    if (distance < 0.1) {
      // Arrived at target
      setAgentPosition(agentId, [targetPos.x, targetPos.y, targetPos.z]);
      updateAgent(agentId, { targetPosition: null, state: agent.currentTask ? "WORKING" : "IDLE" });
      return;
    }

    const startTime = Date.now();
    const duration = (distance / speed) * 1000;

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      const newPos = currentPos.clone().add(direction.clone().multiplyScalar(progress));
      setAgentPosition(agentId, [newPos.x, newPos.y, newPos.z]);

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        updateAgent(agentId, { targetPosition: null, state: "IDLE" });
      }
    };

    animate();
  }, [agent, agentId, setAgentPosition, updateAgent]);
}

// ============================================================================
// Agent Pool Component - Renders all agents
// ============================================================================

interface AgentPoolProps {
  onAgentClick?: (agentId: string) => void;
}

export function AgentPool({ onAgentClick }: AgentPoolProps) {
  const agents = useGameStore((state) => state.agents);
  const selectedAgentIds = useGameStore((state) => state.selectedAgentIds);
  const hoverAgentId = useGameStore((state) => state.hoverAgentId);

  const setHoverAgent = useGameStore((state) => state.setHoverAgent);

  // Convert agents Map to array for rendering
  const agentsArray = useMemo(() => Array.from(agents.values()), [agents]);

  return (
    <>
      {agentsArray.map((agent) => (
        <GameAgentVisual
          key={agent.id}
          agent={agent}
          isSelected={selectedAgentIds.has(agent.id)}
          isHovered={hoverAgentId === agent.id}
          onPointerOver={() => setHoverAgent(agent.id)}
          onPointerOut={() => setHoverAgent(null)}
          onClick={() => {
            onAgentClick?.(agent.id);
          }}
        />
      ))}

      {/* Connection lines between parent and child agents */}
      {agentsArray
        .filter((agent) => agent.parentId)
        .map((agent) => {
          const parent = agentsArray.find((a) => a.id === agent.parentId);
          if (!parent) return null;

          const startPos = new Vector3(...parent.position);
          const endPos = new Vector3(...agent.position);
          const midPos = startPos.clone().add(endPos).multiplyScalar(0.5).add(new Vector3(0, 2, 0));

          return (
            <group key={`connection-${agent.id}-${agent.parentId}`}>
              {/* Curved line */}
              <mesh>
                <tubeGeometry
                  args={[
                    new THREE.CatmullRomCurve3([
                      startPos,
                      midPos,
                      endPos,
                    ]),
                    8,
                    0.02,
                    4,
                    false,
                  ]}
                />
                <meshBasicMaterial color="#9b59b6" transparent opacity={0.5} />
              </mesh>
            </group>
          );
        })}
    </>
  );
}

// ============================================================================
// Agent Spawn Effect Component
// ============================================================================

interface AgentSpawnEffectProps {
  position: [number, number, number];
  onComplete?: () => void;
}

export function AgentSpawnEffect({ position, onComplete }: AgentSpawnEffectProps) {
  const meshRef = useRef<Group>(null);
  const [scale, setScale] = React.useState(0);
  const [opacity, setOpacity] = React.useState(1);

  useFrame((state) => {
    if (!meshRef.current) return;

    const time = state.clock.elapsedTime;
    const progress = (time % 1) / 1; // 1 second animation

    setScale(progress * 2);
    setOpacity(1 - progress);

    if (progress >= 1) {
      onComplete?.();
    }
  });

  if (opacity <= 0) return null;

  return (
    <group ref={meshRef} position={position}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0, scale * 2, 32]} />
        <meshBasicMaterial color="#f4d03f" transparent opacity={opacity} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[scale, scale * 1.5, 32]} />
        <meshBasicMaterial color="#3498db" transparent opacity={opacity * 0.5} />
      </mesh>
    </group>
  );
}

import React from "react";

// ============================================================================
// Export types and components
// ============================================================================

export type { GameAgentVisualProps };
