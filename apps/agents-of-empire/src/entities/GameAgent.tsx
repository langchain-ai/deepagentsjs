import { useRef, useEffect, useMemo, useState, useCallback } from "react";
import { useFrame } from "@react-three/fiber";
import { Group, Vector3, Color, Object3D, InstancedMesh } from "three";
import { Text, Limit } from "@react-three/drei";
import { useGameStore, useAgentsShallow, type AgentState, type GameAgent as GameAgentType } from "../store/gameStore";

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
// Performance Configuration
// ============================================================================

const MAX_AGENTS = 500;
const AGENT_BODY_HEIGHT = 1.5;
const AGENT_SCALE = 0.8;

// ============================================================================
// Agent State Icons (emojis for now, could be textures)
// ============================================================================

// ============================================================================
// Individual Agent Component (for selected/hovered agents only)
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
      if (groupRef.current) {
        groupRef.current.position.y = Math.sin(time * 3) * 0.2 + 0.5;
      }
    } else {
      if (groupRef.current) {
        groupRef.current.position.y = 0;
      }
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
    </group>
  );
}

// ============================================================================
// Instanced Agent Renderer - For high performance rendering of 100+ agents
// ============================================================================

interface InstancedAgentRendererProps {
  agents: GameAgentType[];
  selectedAgentIds: Set<string>;
  hoverAgentId: string | null;
  onAgentClick: (agentId: string) => void;
  onAgentHover: (agentId: string | null) => void;
}

export function InstancedAgentRenderer({
  agents,
  selectedAgentIds,
  hoverAgentId,
  onAgentClick,
  onAgentHover,
}: InstancedAgentRendererProps) {
  const bodyMeshRef = useRef<InstancedMesh>(null);
  const headMeshRef = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const color = useMemo(() => new Color(), []);

  // Agent data maps for quick lookup
  const agentMap = useMemo(() => {
    const map = new Map<string, GameAgentType>();
    for (const agent of agents) {
      map.set(agent.id, agent);
    }
    return map;
  }, [agents]);

  // Get IDs of agents that need individual rendering (selected or hovered)
  const specialAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of selectedAgentIds) {
      ids.add(id);
    }
    if (hoverAgentId) {
      ids.add(hoverAgentId);
    }
    return ids;
  }, [selectedAgentIds, hoverAgentId]);

  // Filter agents for instanced rendering (excluding selected/hovered)
  const instancedAgents = useMemo(() => {
    return agents.filter((agent) => !specialAgentIds.has(agent.id));
  }, [agents, specialAgentIds]);

  // Update instanced meshes
  useFrame(() => {
    if (!bodyMeshRef.current || !headMeshRef.current) return;

    let index = 0;

    for (const agent of instancedAgents) {
      const [x, y, z] = agent.position;

      // Body instance
      dummy.position.set(x, y + 0.5, z);
      dummy.scale.setScalar(AGENT_SCALE);
      dummy.updateMatrix();
      bodyMeshRef.current.setMatrixAt(index, dummy.matrix);

      // Color based on state
      color.set(AGENT_STATE_COLORS[agent.state]);
      bodyMeshRef.current.setColorAt(index, color);

      // Head instance (slightly above body)
      dummy.position.set(x, y + 1.2, z);
      dummy.scale.setScalar(AGENT_SCALE * 0.6);
      dummy.updateMatrix();
      headMeshRef.current.setMatrixAt(index, dummy.matrix);

      // Head color matches body
      headMeshRef.current.setColorAt(index, color);

      index++;
    }

    bodyMeshRef.current.instanceMatrix.needsUpdate = true;
    if (bodyMeshRef.current.instanceColor) {
      bodyMeshRef.current.instanceColor.needsUpdate = true;
    }
    headMeshRef.current.instanceMatrix.needsUpdate = true;
    if (headMeshRef.current.instanceColor) {
      headMeshRef.current.instanceColor.needsUpdate = true;
    }
  });

  // Handle click on instanced agents
  const handleClick = (event: any) => {
    event.stopPropagation();
    const instanceId = event.instanceId;
    if (instanceId !== undefined && instancedAgents[instanceId]) {
      onAgentClick(instancedAgents[instanceId].id);
    }
  };

  const handlePointerMove = (event: any) => {
    const instanceId = event.instanceId;
    if (instanceId !== undefined && instancedAgents[instanceId]) {
      onAgentHover(instancedAgents[instanceId].id);
    } else {
      onAgentHover(null);
    }
  };

  return (
    <>
      {/* Instanced body meshes */}
      <instancedMesh
        ref={bodyMeshRef}
        args={[undefined, undefined, instancedAgents.length]}
        castShadow
        receiveShadow
        onClick={handleClick}
        onPointerMove={handlePointerMove}
        onPointerOut={() => onAgentHover(null)}
      >
        <boxGeometry args={[0.8, 1, 0.5]} />
        <meshStandardMaterial />
      </instancedMesh>

      {/* Instanced head meshes */}
      <instancedMesh
        ref={headMeshRef}
        args={[undefined, undefined, instancedAgents.length]}
        castShadow
        onClick={handleClick}
        onPointerMove={handlePointerMove}
      >
        <boxGeometry args={[0.5, 0.5, 0.5]} />
        <meshStandardMaterial />
      </instancedMesh>
    </>
  );
}

// ============================================================================
// LOD Agent Renderer - Uses InstancedRenderer for far agents
// ============================================================================

interface LODAgentRendererProps {
  agents: GameAgentType[];
  selectedAgentIds: Set<string>;
  hoverAgentId: string | null;
  onAgentClick: (agentId: string) => void;
  onAgentHover: (agentId: string | null) => void;
}

export function LODAgentRenderer({
  agents,
  selectedAgentIds,
  hoverAgentId,
  onAgentClick,
  onAgentHover,
}: LODAgentRendererProps) {
  // Agents that need detailed rendering (selected, hovered, or nearby)
  const [nearbyAgents, setNearbyAgents] = useState<GameAgentType[]>([]);
  const [cameraPosition, setCameraPosition] = useState(new Vector3(40, 40, 40));

  // Update camera position for LOD calculation
  useFrame((state) => {
    if (state.camera.position.distanceTo(cameraPosition) > 1) {
      setCameraPosition(state.camera.position.clone());
    }
  });

  // Calculate which agents should be rendered in detail
  useEffect(() => {
    const NEAR_THRESHOLD = 30; // Distance threshold for detailed rendering
    const detailed: GameAgentType[] = [];

    for (const agent of agents) {
      const agentPos = new Vector3(...agent.position);
      const distance = agentPos.distanceTo(cameraPosition);

      // Always render selected/hovered agents in detail
      if (selectedAgentIds.has(agent.id) || hoverAgentId === agent.id) {
        detailed.push(agent);
      }
      // Render nearby agents in detail
      else if (distance < NEAR_THRESHOLD) {
        detailed.push(agent);
      }
    }

    setNearbyAgents(detailed);
  }, [agents, selectedAgentIds, hoverAgentId, cameraPosition]);

  // Agents to render as instances (far away, not selected/hovered)
  const instancedAgentIds = useMemo(() => {
    const detailedIds = new Set(nearbyAgents.map((a) => a.id));
    return agents.filter((a) => !detailedIds.has(a.id));
  }, [agents, nearbyAgents]);

  return (
    <>
      {/* Instanced rendering for far agents */}
      <InstancedAgentRenderer
        agents={instancedAgentIds}
        selectedAgentIds={selectedAgentIds}
        hoverAgentId={hoverAgentId}
        onAgentClick={onAgentClick}
        onAgentHover={onAgentHover}
      />

      {/* Detailed rendering for nearby/selected agents */}
      {nearbyAgents.map((agent) => (
        <GameAgentVisual
          key={agent.id}
          agent={agent}
          isSelected={selectedAgentIds.has(agent.id)}
          isHovered={hoverAgentId === agent.id}
          onPointerOver={() => onAgentHover(agent.id)}
          onPointerOut={() => onAgentHover(null)}
          onClick={() => onAgentClick(agent.id)}
        />
      ))}
    </>
  );
}

// ============================================================================
// Agent Pool Component - Renders all agents with LOD
// ============================================================================

interface AgentPoolProps {
  onAgentClick?: (agentId: string) => void;
}

export function AgentPool({ onAgentClick }: AgentPoolProps) {
  const agents = useAgentsShallow() as Record<string, GameAgentType>;
  const selectedAgentIds = useGameStore((state) => state.selectedAgentIds);
  const hoverAgentId = useGameStore((state) => state.hoverAgentId);
  const setHoverAgent = useGameStore((state) => state.setHoverAgent);

  // Convert agents object to array for rendering
  const agentsArray = useMemo(() => Object.values(agents), [agents]);

  // Handle agent click
  const handleAgentClick = useCallback(
    (agentId: string) => {
      onAgentClick?.(agentId);
    },
    [onAgentClick]
  );

  // Handle agent hover
  const handleAgentHover = useCallback(
    (agentId: string | null) => {
      setHoverAgent(agentId);
    },
    [setHoverAgent]
  );

  // Use LOD renderer for performance
  return (
    <LODAgentRenderer
      agents={agentsArray}
      selectedAgentIds={selectedAgentIds}
      hoverAgentId={hoverAgentId}
      onAgentClick={handleAgentClick}
      onAgentHover={handleAgentHover}
    />
  );
}

// ============================================================================
// Agent Movement Hook
// ============================================================================

export function useAgentMovement(agentId: string) {
  const agent = useGameStore((state) => state.agents[agentId]);
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
// Agent Spawn Effect Component
// ============================================================================

interface AgentSpawnEffectProps {
  position: [number, number, number];
  onComplete?: () => void;
}

export function AgentSpawnEffect({ position, onComplete }: AgentSpawnEffectProps) {
  const meshRef = useRef<Group>(null);
  const [scale, setScale] = useState(0);
  const [opacity, setOpacity] = useState(1);

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
