import { useRef, useEffect, useMemo, useState, useCallback } from "react";
import { useFrame } from "@react-three/fiber";
import { Group, Vector3, Color, Object3D, InstancedMesh } from "three";
import { Text } from "@react-three/drei";
import { useGameStore, useAgentsShallow, type AgentState, type GameAgent as GameAgentType } from "../store/gameStore";

// ============================================================================
// Agent State Visual Configurations
// ============================================================================

// State animation configuration
interface StateAnimationConfig {
  color: string;
  emissive: string;
  icon: string;
  pulseSpeed?: number;
  pulseAmount?: number;
  shakeIntensity?: number;
  glowIntensity?: number;
}

const AGENT_STATE_CONFIG: Record<AgentState, StateAnimationConfig> = {
  IDLE: {
    color: "#3498db",      // Blue
    emissive: "#1a5276",
    icon: "💤",
    pulseSpeed: 0.5,
    pulseAmount: 0.02,
  },
  THINKING: {
    color: "#9b59b6",      // Purple
    emissive: "#6c3483",
    icon: "🤔",
    pulseSpeed: 3,
    pulseAmount: 0.12,
    glowIntensity: 0.6,
  },
  MOVING: {
    color: "#2ecc71",      // Green
    emissive: "#1e8449",
    icon: "🏃",
    pulseSpeed: 0,
    pulseAmount: 0,
  },
  WORKING: {
    color: "#f39c12",      // Orange
    emissive: "#b7950b",
    icon: "⚒️",
    pulseSpeed: 4,
    pulseAmount: 0.05,
    glowIntensity: 0.4,
  },
  ERROR: {
    color: "#e74c3c",      // Red
    emissive: "#c0392b",
    icon: "❌",
    pulseSpeed: 8,
    pulseAmount: 0.08,
    shakeIntensity: 0.15,
    glowIntensity: 0.8,
  },
  COMPLETING: {
    color: "#f4d03f",      // Gold
    emissive: "#b7950b",
    icon: "✨",
    pulseSpeed: 6,
    pulseAmount: 0.15,
    glowIntensity: 1.0,
  },
  COMBAT: {
    color: "#e74c3c",      // Red
    emissive: "#c0392b",
    icon: "⚔️",
    pulseSpeed: 5,
    pulseAmount: 0.1,
    shakeIntensity: 0.1,
    glowIntensity: 0.5,
  },
};

// Backwards compatibility exports
const AGENT_STATE_COLORS: Record<AgentState, string> = {
  IDLE: AGENT_STATE_CONFIG.IDLE.color,
  THINKING: AGENT_STATE_CONFIG.THINKING.color,
  MOVING: AGENT_STATE_CONFIG.MOVING.color,
  WORKING: AGENT_STATE_CONFIG.WORKING.color,
  ERROR: AGENT_STATE_CONFIG.ERROR.color,
  COMPLETING: AGENT_STATE_CONFIG.COMPLETING.color,
  COMBAT: AGENT_STATE_CONFIG.COMBAT.color,
};

const AGENT_STATE_EMISSIVE: Record<AgentState, string> = {
  IDLE: AGENT_STATE_CONFIG.IDLE.emissive,
  THINKING: AGENT_STATE_CONFIG.THINKING.emissive,
  MOVING: AGENT_STATE_CONFIG.MOVING.emissive,
  WORKING: AGENT_STATE_CONFIG.WORKING.emissive,
  ERROR: AGENT_STATE_CONFIG.ERROR.emissive,
  COMPLETING: AGENT_STATE_CONFIG.COMPLETING.emissive,
  COMBAT: AGENT_STATE_CONFIG.COMBAT.emissive,
};

const AGENT_STATE_ICONS: Record<AgentState, string> = {
  IDLE: AGENT_STATE_CONFIG.IDLE.icon,
  THINKING: AGENT_STATE_CONFIG.THINKING.icon,
  MOVING: AGENT_STATE_CONFIG.MOVING.icon,
  WORKING: AGENT_STATE_CONFIG.WORKING.icon,
  ERROR: AGENT_STATE_CONFIG.ERROR.icon,
  COMPLETING: AGENT_STATE_CONFIG.COMPLETING.icon,
  COMBAT: AGENT_STATE_CONFIG.COMBAT.icon,
};

// ============================================================================
// Performance Configuration
// ============================================================================

const AGENT_SCALE = 0.8;

// ============================================================================
// State Transition Configuration
// ============================================================================

const COLOR_TRANSITION_DURATION = 0.3; // seconds for color interpolation

// ============================================================================
// Particle System for State Effects
// ============================================================================

interface Particle {
  position: [number, number, number];
  velocity: [number, number, number];
  life: number;
  maxLife: number;
  size: number;
  color: string;
}

interface StateParticlesProps {
  agentState: AgentState;
  position: [number, number, number];
  onComplete?: () => void;
}

function StateParticles({ agentState, position, onComplete }: StateParticlesProps) {
  const particlesRef = useRef<Group>(null);
  const [particles, setParticles] = useState<Particle[]>([]);

  // Spawn particles based on state
  useEffect(() => {
    if (agentState === "COMPLETING") {
      // Celebration particles
      const newParticles: Particle[] = [];
      for (let i = 0; i < 20; i++) {
        const angle = (i / 20) * Math.PI * 2;
        const speed = 2 + Math.random() * 2;
        newParticles.push({
          position: [0, 1.5, 0],
          velocity: [
            Math.cos(angle) * speed,
            1 + Math.random() * 2,
            Math.sin(angle) * speed,
          ],
          life: 1,
          maxLife: 1,
          size: 0.1 + Math.random() * 0.1,
          color: Math.random() > 0.5 ? "#f4d03f" : "#3498db",
        });
      }
      setParticles(newParticles);

      // Auto-complete after animation
      const timer = setTimeout(() => {
        setParticles([]);
        onComplete?.();
      }, 1000);
      return () => clearTimeout(timer);
    } else if (agentState === "ERROR") {
      // Error sparks
      const newParticles: Particle[] = [];
      for (let i = 0; i < 8; i++) {
        newParticles.push({
          position: [
            (Math.random() - 0.5) * 0.5,
            0.5 + Math.random(),
            (Math.random() - 0.5) * 0.5,
          ],
          velocity: [
            (Math.random() - 0.5) * 3,
            Math.random() * 2,
            (Math.random() - 0.5) * 3,
          ],
          life: 0.5,
          maxLife: 0.5,
          size: 0.05 + Math.random() * 0.05,
          color: "#e74c3c",
        });
      }
      setParticles(newParticles);

      const timer = setTimeout(() => {
        setParticles([]);
      }, 500);
      return () => clearTimeout(timer);
    } else {
      setParticles([]);
    }
  }, [agentState, onComplete]);

  // Animate particles
  useFrame((state, delta) => {
    if (particles.length === 0) return;

    setParticles((prev) =>
      prev
        .map((p) => ({
          ...p,
          position: [
            p.position[0] + p.velocity[0] * delta,
            p.position[1] + p.velocity[1] * delta,
            p.position[2] + p.velocity[2] * delta,
          ],
          velocity: [
            p.velocity[0],
            p.velocity[1] - 3 * delta, // gravity
            p.velocity[2],
          ],
          life: p.life - delta,
        }))
        .filter((p) => p.life > 0)
    );
  });

  if (particles.length === 0) return null;

  return (
    <group ref={particlesRef} position={position}>
      {particles.map((p, i) => (
        <mesh key={i} position={p.position}>
          <sphereGeometry args={[p.size * (p.life / p.maxLife), 8, 8]} />
          <meshBasicMaterial color={p.color} transparent opacity={p.life / p.maxLife} />
        </mesh>
      ))}
    </group>
  );
}

// ============================================================================
// Trail Effect for MOVING State
// ============================================================================

interface AgentTrailProps {
  position: [number, number, number];
  active: boolean;
}

function AgentTrail({ position, active }: AgentTrailProps) {
  const trailRef = useRef<Group>(null);
  const [trailPositions, setTrailPositions] = useState<[number, number, number][]>([]);

  useFrame(() => {
    if (!active) {
      setTrailPositions([]);
      return;
    }

    // Add current position to trail
    setTrailPositions((prev) => {
      const newTrail = [position, ...prev].slice(0, 10); // Keep last 10 positions
      return newTrail;
    });
  });

  if (trailPositions.length < 2) return null;

  return (
    <group ref={trailRef}>
      {trailPositions.map((pos, i) => {
        const alpha = 1 - i / trailPositions.length;
        const size = 0.3 * alpha;
        return (
          <mesh key={i} position={pos}>
            <sphereGeometry args={[size, 8, 8]} />
            <meshBasicMaterial color="#2ecc71" transparent opacity={alpha * 0.3} />
          </mesh>
        );
      })}
    </group>
  );
}

// ============================================================================
// Completion Ring Effect
// ============================================================================

interface CompletionRingProps {
  position: [number, number, number];
  active: boolean;
}

function CompletionRing({ position, active }: CompletionRingProps) {
  const ringRef = useRef<Group>(null);
  const [scale, setScale] = useState(0);
  const [opacity, setOpacity] = useState(0);

  useFrame((state, delta) => {
    if (!active) {
      setScale(0);
      setOpacity(0);
      return;
    }

    // Animate ring expansion
    setScale((prev) => Math.min(prev + delta * 3, 3));
    setOpacity((prev) => Math.max(prev - delta * 1.5, 0));
  });

  if (scale <= 0) return null;

  return (
    <group ref={ringRef} position={position}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.1, 0]}>
        <ringGeometry args={[0.8, scale, 32]} />
        <meshBasicMaterial color="#f4d03f" transparent opacity={opacity * 0.8} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.15, 0]}>
        <ringGeometry args={[0.8, scale * 1.2, 32]} />
        <meshBasicMaterial color="#3498db" transparent opacity={opacity * 0.4} />
      </mesh>
    </group>
  );
}

// ============================================================================
// Glow Effect for THINKING, WORKING, ERROR, COMPLETING States
// ============================================================================

interface StateGlowProps {
  state: AgentState;
  position: [number, number, number];
}

function StateGlow({ state, position }: StateGlowProps) {
  const glowRef = useRef<Group>(null);
  const config = AGENT_STATE_CONFIG[state];
  const hasGlow = config.glowIntensity && config.glowIntensity > 0;

  useFrame((stateFrame) => {
    if (!glowRef.current || !hasGlow) return;

    const time = stateFrame.clock.elapsedTime;
    const pulse = Math.sin(time * (config.pulseSpeed || 3)) * 0.1 + 0.9;
    glowRef.current.scale.setScalar(pulse);
  });

  if (!hasGlow) return null;

  const glowColor = config.color;

  return (
    <group ref={glowRef} position={position}>
      <mesh position={[0, 0.75, 0]}>
        <sphereGeometry args={[1, 16, 16]} />
        <meshBasicMaterial
          color={glowColor}
          transparent
          opacity={(config.glowIntensity || 0.5) * 0.3}
        />
      </mesh>
    </group>
  );
}

// ============================================================================
// Individual Agent Component (for selected/hovered agents only)
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
  const leftArmRef = useRef<Group>(null);
  const rightArmRef = useRef<Group>(null);
  const pulseRef = useRef(0);
  const workAnimRef = useRef(0);

  // State config for this agent
  const stateConfig = AGENT_STATE_CONFIG[agent.state];

  // Color based on state with smooth transition
  const targetColor = useMemo(() => new Color(AGENT_STATE_COLORS[agent.state]), [agent.state]);
  const targetEmissive = useMemo(() => new Color(AGENT_STATE_EMISSIVE[agent.state]), [agent.state]);
  const currentColorRef = useRef(targetColor.clone());
  const currentEmissiveRef = useRef(targetEmissive.clone());

  // Smooth color transition
  useFrame((_state, delta) => {
    const lerpFactor = Math.min(delta / COLOR_TRANSITION_DURATION, 1);
    currentColorRef.current.lerp(targetColor, lerpFactor);
    currentEmissiveRef.current.lerp(targetEmissive, lerpFactor);
  });

  // Enhanced state-based animations
  useFrame((stateFrame) => {
    if (!bodyRef.current) return;

    const time = stateFrame.clock.elapsedTime;
    const config = AGENT_STATE_CONFIG[agent.state];

    // Base bob animation - varies by state
    const bobAmount = config.pulseAmount || 0.03;
    const bobSpeed = config.pulseSpeed || 2;
    bodyRef.current.position.y = Math.sin(time * bobSpeed) * bobAmount;

    // Rotate when moving
    if (agent.targetPosition && agent.state === "MOVING") {
      const currentPos = new Vector3(...agent.position);
      const targetPos = new Vector3(...agent.targetPosition);
      const direction = targetPos.sub(currentPos).normalize();
      const angle = Math.atan2(direction.x, direction.z);
      bodyRef.current.rotation.y = angle;
    }

    // Pulse/Scale effect based on state
    if (config.pulseAmount && config.pulseAmount > 0.05) {
      pulseRef.current += 0.05;
      const scale = 1 + Math.sin(pulseRef.current) * (config.pulseAmount || 0.1);
      bodyRef.current.scale.setScalar(scale);
    } else {
      bodyRef.current.scale.setScalar(1);
    }

    // ERROR state: Shake/jitter animation
    if (agent.state === "ERROR" || agent.state === "COMBAT") {
      const shakeIntensity = config.shakeIntensity || 0.15;
      bodyRef.current.rotation.x = (Math.random() - 0.5) * shakeIntensity;
      bodyRef.current.rotation.z = (Math.random() - 0.5) * shakeIntensity;
    } else {
      bodyRef.current.rotation.x = 0;
      bodyRef.current.rotation.z = 0;
    }

    // WORKING state: Tool swing animation
    if (agent.state === "WORKING") {
      workAnimRef.current += 0.1;
      const swingAngle = Math.sin(workAnimRef.current) * 0.5;
      if (leftArmRef.current) {
        leftArmRef.current.rotation.x = swingAngle;
      }
      if (rightArmRef.current) {
        rightArmRef.current.rotation.x = -swingAngle;
      }
    } else {
      if (leftArmRef.current) leftArmRef.current.rotation.x = 0;
      if (rightArmRef.current) rightArmRef.current.rotation.x = 0;
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
      {/* State-based visual effects */}
      <StateParticles agentState={agent.state} position={[0, 0, 0]} />
      <CompletionRing position={[0, 0, 0]} active={agent.state === "COMPLETING"} />
      <StateGlow state={agent.state} position={[0, 0, 0]} />
      <AgentTrail position={agent.position} active={agent.state === "MOVING"} />

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
          <meshStandardMaterial
            color={currentColorRef.current}
            emissive={currentEmissiveRef.current}
            emissiveIntensity={(stateConfig.glowIntensity || 0.3) * 0.5}
          />
        </mesh>

        {/* Head */}
        <mesh castShadow position={[0, 1.2, 0]}>
          <boxGeometry args={[0.5, 0.5, 0.5]} />
          <meshStandardMaterial
            color={currentColorRef.current}
            emissive={currentEmissiveRef.current}
            emissiveIntensity={(stateConfig.glowIntensity || 0.3) * 0.5}
          />
        </mesh>

        {/* Arms with animated refs */}
        <group ref={leftArmRef} position={[-0.5, 0.6, 0]}>
          <mesh castShadow position={[0, 0, 0]}>
            <boxGeometry args={[0.2, 0.6, 0.2]} />
            <meshStandardMaterial
              color={currentColorRef.current}
              emissive={currentEmissiveRef.current}
              emissiveIntensity={(stateConfig.glowIntensity || 0.3) * 0.5}
            />
          </mesh>
        </group>
        <group ref={rightArmRef} position={[0.5, 0.6, 0]}>
          <mesh castShadow position={[0, 0, 0]}>
            <boxGeometry args={[0.2, 0.6, 0.2]} />
            <meshStandardMaterial
              color={currentColorRef.current}
              emissive={currentEmissiveRef.current}
              emissiveIntensity={(stateConfig.glowIntensity || 0.3) * 0.5}
            />
          </mesh>
        </group>

        {/* Legs */}
        <mesh castShadow position={[-0.2, -0.3, 0]}>
          <boxGeometry args={[0.2, 0.4, 0.2]} />
          <meshStandardMaterial
            color={currentColorRef.current}
            emissive={currentEmissiveRef.current}
            emissiveIntensity={(stateConfig.glowIntensity || 0.3) * 0.5}
          />
        </mesh>
        <mesh castShadow position={[0.2, -0.3, 0]}>
          <boxGeometry args={[0.2, 0.4, 0.2]} />
          <meshStandardMaterial
            color={currentColorRef.current}
            emissive={currentEmissiveRef.current}
            emissiveIntensity={(stateConfig.glowIntensity || 0.3) * 0.5}
          />
        </mesh>
      </group>

      {/* Tool indicator */}
      {agent.equippedTool && (
        <mesh position={[0.7, 0.8, 0]}>
          <sphereGeometry args={[0.15, 8, 8]} />
          <meshBasicMaterial color="#f4d03f" />
        </mesh>
      )}

      {/* State icon (floating above) - show for all states now with enhanced visibility */}
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

// ============================================================================
// Export types and components
// ============================================================================

export type { GameAgentVisualProps };
