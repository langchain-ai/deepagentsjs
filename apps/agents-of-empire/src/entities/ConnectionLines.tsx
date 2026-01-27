import { useRef, useMemo, useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import { Vector3, Color, TubeGeometry, MeshBasicMaterial, CatmullRomCurve3 } from "three";
import { useAgentsShallow } from "../store/gameStore";

// ============================================================================
// Types
// ============================================================================

export type ConnectionType = "parent-child" | "collaborating" | "moving-together";

export interface AgentConnection {
  fromAgentId: string;
  toAgentId: string;
  type: ConnectionType;
  startTime: number;
  intensity: number;
}

// ============================================================================
// Color Configuration by Connection Type
// ============================================================================

const CONNECTION_COLORS: Record<ConnectionType, string> = {
  "parent-child": "#00d4ff", // Cyan for subagent relationships
  "collaborating": "#2ecc71", // Green for working together
  "moving-together": "#f4d03f", // Yellow for coordinated movement
};

const CONNECTION_EMISSIVE: Record<ConnectionType, string> = {
  "parent-child": "#0088aa",
  "collaborating": "#1e8449",
  "moving-together": "#b7950b",
};

const CONNECTION_OPACITY: Record<ConnectionType, number> = {
  "parent-child": 0.8,
  "collaborating": 0.6,
  "moving-together": 0.4,
};

// ============================================================================
// Connection Line Component (Individual Line)
// ============================================================================

interface ConnectionLineProps {
  startPoint: Vector3;
  endPoint: Vector3;
  type: ConnectionType;
  intensity: number;
  age: number;
  key: string;
}

function ConnectionLine({ startPoint, endPoint, type, intensity }: ConnectionLineProps) {
  const meshRef = useRef<any>(null);
  const materialRef = useRef<MeshBasicMaterial | null>(null);

  const baseColor = CONNECTION_COLORS[type];
  const emissiveColor = CONNECTION_EMISSIVE[type];
  const baseOpacity = CONNECTION_OPACITY[type];

  // Create curved path for the tube geometry
  const curve = useMemo(() => {
    // Control points for curved line (slight arc)
    const midPoint = new Vector3()
      .addVectors(startPoint, endPoint)
      .multiplyScalar(0.5);

    // Add slight arc upward based on distance
    const distance = startPoint.distanceTo(endPoint);
    midPoint.y += distance * 0.1;

    // Create curve through start, mid, and end points
    return new CatmullRomCurve3([
      startPoint.clone(),
      midPoint,
      endPoint.clone(),
    ], false, "catmullrom", 0.5);
  }, [startPoint, endPoint]);

  // Create tube geometry from curve
  const geometry = useMemo(() => {
    // Use fewer segments for performance
    const tubularSegments = Math.max(3, Math.floor(curve.getLength() / 2));
    const radius = 0.05 + intensity * 0.05;
    const radialSegments = 6;
    const closed = false;

    return new TubeGeometry(curve, tubularSegments, radius, radialSegments, closed);
  }, [curve, intensity]);

  // Create material with glow effect
  const material = useMemo(() => {
    const mat = new MeshBasicMaterial({
      color: baseColor,
      transparent: true,
      opacity: baseOpacity * intensity,
      blending: 2, // Additive blending for glow effect
      depthTest: false,
    });
    materialRef.current = mat;
    return mat;
  }, [baseColor, baseOpacity, intensity]);

  // Update animation
  useFrame((state) => {
    if (meshRef.current && materialRef.current) {
      // Pulse animation
      const pulse = Math.sin(state.clock.elapsedTime * 3 + age) * 0.2 + 0.8;
      materialRef.current.opacity = baseOpacity * pulse * intensity;

      // Subtle scale pulse
      const scalePulse = 1 + Math.sin(state.clock.elapsedTime * 2) * 0.1;
      meshRef.current.scale.setScalar(scalePulse);
    }
  });

  // Calculate age offset for varied pulse timing
  const age = Math.random() * 100;

  // Clean up geometry on unmount
  useEffect(() => {
    return () => {
      geometry.dispose();
      if (materialRef.current) {
        materialRef.current.dispose();
      }
    };
  }, [geometry]);

  return (
    <mesh ref={meshRef} geometry={geometry} material={material} />
  );
}

// ============================================================================
// Connection Lines Manager Component
// ============================================================================

interface ConnectionLinesProps {
  enabled?: boolean;
  maxConnections?: number;
}

export function ConnectionLines({
  enabled = true,
  maxConnections = 100,
}: ConnectionLinesProps) {
  const agents = useAgentsShallow() as Record<string, any>;
  const connectionsRef = useRef<AgentConnection[]>([]);
  const lastUpdateRef = useRef(0);
  const updateInterval = 100; // Update every 100ms

  // Find all connections based on agent relationships
  const updateConnections = useMemo(() => {
    return () => {
      const now = Date.now();
      if (now - lastUpdateRef.current < updateInterval) {
        return;
      }
      lastUpdateRef.current = now;

      const connections: AgentConnection[] = [];
      const agentList = Object.values(agents);
      const agentIds = new Set(Object.keys(agents));

      // Track existing connections to update intensity
      const existingConnections = new Map<string, AgentConnection>();
      for (const conn of connectionsRef.current) {
        const key = `${conn.fromAgentId}-${conn.toAgentId}`;
        existingConnections.set(key, conn);
      }

      // Find parent-child connections (subagent relationships)
      for (const agent of agentList) {
        if (agent.parentId && agentIds.has(agent.parentId)) {
          const parent = agents[agent.parentId];
          if (parent) {
            const key = `${parent.id}-${agent.id}`;
            const existing = existingConnections.get(key);

            connections.push({
              fromAgentId: parent.id,
              toAgentId: agent.id,
              type: "parent-child",
              startTime: existing?.startTime || now,
              intensity: existing ? Math.min(1, existing.intensity + 0.1) : 0.3,
            });
          }
        }

        // Also check children
        if (agent.childrenIds && Array.isArray(agent.childrenIds)) {
          for (const childId of agent.childrenIds) {
            if (agentIds.has(childId)) {
              const key = `${agent.id}-${childId}`;
              // Avoid duplicates
              if (!connections.find((c) => c.toAgentId === childId && c.fromAgentId === agent.id)) {
                const existing = existingConnections.get(key);

                connections.push({
                  fromAgentId: agent.id,
                  toAgentId: childId,
                  type: "parent-child",
                  startTime: existing?.startTime || now,
                  intensity: existing ? Math.min(1, existing.intensity + 0.1) : 0.3,
                });
              }
            }
          }
        }
      }

      // Find collaborating agents (agents in WORKING state near each other)
      for (let i = 0; i < agentList.length; i++) {
        const agentA = agentList[i];
        if (agentA.state !== "WORKING" && agentA.state !== "THINKING") continue;

        for (let j = i + 1; j < agentList.length; j++) {
          const agentB = agentList[j];
          if (agentB.state !== "WORKING" && agentB.state !== "THINKING") continue;

          // Check distance
          const posA = new Vector3(...agentA.position);
          const posB = new Vector3(...agentB.position);
          const distance = posA.distanceTo(posB);

          // If close enough and both working, show collaboration line
          if (distance < 8 && distance > 0.5) {
            const key = `${agentA.id}-${agentB.id}`;
            const existing = existingConnections.get(key);

            // Only add if not already connected as parent-child
            const isParentChild = connections.some(
              (c) =>
                (c.fromAgentId === agentA.id && c.toAgentId === agentB.id) ||
                (c.fromAgentId === agentB.id && c.toAgentId === agentA.id)
            );

            if (!isParentChild) {
              connections.push({
                fromAgentId: agentA.id,
                toAgentId: agentB.id,
                type: "collaborating",
                startTime: existing?.startTime || now,
                intensity: existing ? Math.min(1, existing.intensity + 0.05) : 0.2,
              });
            }
          }
        }
      }

      // Find agents moving together (MOVING state, same general direction)
      const movingAgents = agentList.filter((a) => a.state === "MOVING" && a.targetPosition);
      for (let i = 0; i < movingAgents.length; i++) {
        const agentA = movingAgents[i];
        for (let j = i + 1; j < movingAgents.length; j++) {
          const agentB = movingAgents[j];

          const posA = new Vector3(...agentA.position);
          const posB = new Vector3(...agentB.position);
          const distance = posA.distanceTo(posB);

          // Check if moving to similar targets
          if (distance < 6 && agentA.targetPosition && agentB.targetPosition) {
            const targetA = new Vector3(...agentA.targetPosition);
            const targetB = new Vector3(...agentB.targetPosition);
            const targetDistance = targetA.distanceTo(targetB);

            // If targets are close, they're moving together
            if (targetDistance < 4) {
              const key = `${agentA.id}-${agentB.id}`;
              const existing = existingConnections.get(key);

              // Avoid duplicates
              const alreadyConnected = connections.some(
                (c) =>
                  (c.fromAgentId === agentA.id && c.toAgentId === agentB.id) ||
                  (c.fromAgentId === agentB.id && c.toAgentId === agentA.id)
              );

              if (!alreadyConnected) {
                connections.push({
                  fromAgentId: agentA.id,
                  toAgentId: agentB.id,
                  type: "moving-together",
                  startTime: existing?.startTime || now,
                  intensity: existing ? Math.min(1, existing.intensity + 0.05) : 0.15,
                });
              }
            }
          }
        }
      }

      connectionsRef.current = connections.slice(0, maxConnections);
    };
  }, [agents, maxConnections]);

  // Update connections on each frame
  useFrame(() => {
    if (enabled) {
      updateConnections();
    }
  });

  if (!enabled) return null;

  const visibleConnections: Array<{
    fromAgentId: string;
    toAgentId: string;
    type: ConnectionType;
    intensity: number;
    age: number;
  }> = [];

  // Build renderable connections with current positions
  for (const conn of connectionsRef.current) {
    const fromAgent = agents[conn.fromAgentId];
    const toAgent = agents[conn.toAgentId];

    if (!fromAgent || !toAgent) continue;

    visibleConnections.push({
      ...conn,
      age: Date.now() - conn.startTime,
    });
  }

  return (
    <group>
      {visibleConnections.map((conn) => {
        const fromAgent = agents[conn.fromAgentId];
        const toAgent = agents[conn.toAgentId];

        if (!fromAgent || !toAgent) return null;

        const startPoint = new Vector3(...fromAgent.position);
        const endPoint = new Vector3(...toAgent.position);

        return (
          <ConnectionLine
            key={`${conn.fromAgentId}-${conn.toAgentId}`}
            startPoint={startPoint}
            endPoint={endPoint}
            type={conn.type}
            intensity={conn.intensity}
            age={conn.age}
          />
        );
      })}
    </group>
  );
}

// ============================================================================
// Hook for managing connections programmatically
// ============================================================================

export function useConnectionLines() {
  const connectionsRef = useRef<AgentConnection[]>([]);

  const addConnection = (
    fromAgentId: string,
    toAgentId: string,
    type: ConnectionType
  ) => {
    const connection: AgentConnection = {
      fromAgentId,
      toAgentId,
      type,
      startTime: Date.now(),
      intensity: 0.5,
    };

    // Check for duplicates
    const exists = connectionsRef.current.some(
      (c) => c.fromAgentId === fromAgentId && c.toAgentId === toAgentId
    );

    if (!exists) {
      connectionsRef.current.push(connection);
    }
  };

  const removeConnection = (fromAgentId: string, toAgentId: string) => {
    connectionsRef.current = connectionsRef.current.filter(
      (c) => !(c.fromAgentId === fromAgentId && c.toAgentId === toAgentId)
    );
  };

  const clearConnections = () => {
    connectionsRef.current = [];
  };

  const getConnections = () => {
    return connectionsRef.current;
  };

  return {
    addConnection,
    removeConnection,
    clearConnections,
    getConnections,
  };
}

// ============================================================================
// Connection Legend Component (UI)
// ============================================================================

export interface ConnectionLegendProps {
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}

export function ConnectionLegend({ position = "bottom-left" }: ConnectionLegendProps) {
  const positionClasses: Record<typeof position, string> = {
    "top-left": "top-4 left-4",
    "top-right": "top-52 right-4", // Position below the minimap (which is 220px tall + margins)
    "bottom-left": "bottom-4 left-4",
    "bottom-right": "bottom-4 right-4",
  };

  return (
    <div className={`absolute ${positionClasses[position]} bg-gray-900/90 border border-gray-700 rounded-lg p-3 text-white text-sm z-10`}>
      <h4 className="text-empire-gold font-semibold mb-2">Connection Types</h4>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <div className="w-6 h-0.5 bg-[#00d4ff]" style={{ boxShadow: "0 0 4px #00d4ff" }} />
          <span className="text-gray-300">Parent-Child (Subagent)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-6 h-0.5 bg-[#2ecc71]" style={{ boxShadow: "0 0 4px #2ecc71" }} />
          <span className="text-gray-300">Collaborating</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-6 h-0.5 bg-[#f4d03f]" style={{ boxShadow: "0 0 4px #f4d03f" }} />
          <span className="text-gray-300">Moving Together</span>
        </div>
      </div>
    </div>
  );
}
