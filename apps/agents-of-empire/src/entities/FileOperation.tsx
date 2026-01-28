import { useRef, useEffect, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Group, Vector3 } from "three";
import { Text } from "@react-three/drei";

// ============================================================================
// File Operation Visual Component
// Shows visual feedback for file read/write operations
// ============================================================================

interface FileOperationProps {
  position: [number, number, number];
  type: "read" | "write";
  filename: string;
  onComplete?: () => void;
}

export function FileOperation({ position, type, filename, onComplete }: FileOperationProps) {
  const groupRef = useRef<Group>(null);
  const [scale, setScale] = useState(0);
  const [opacity, setOpacity] = useState(1);
  const [floatY, setFloatY] = useState(0);

  useEffect(() => {
    // Entry animation
    let entryFrame = 0;
    const animateEntry = () => {
      entryFrame++;
      const progress = Math.min(entryFrame / 20, 1);
      setScale(progress);
      if (progress < 1) {
        requestAnimationFrame(animateEntry);
      }
    };
    animateEntry();

    // Auto-complete after animation
    const timer = setTimeout(() => {
      setOpacity(0);
      setTimeout(() => onComplete?.(), 500);
    }, 2000);

    return () => clearTimeout(timer);
  }, [onComplete]);

  useFrame((state) => {
    // Float upward
    setFloatY((prev) => prev + 0.02);
  });

  const icon = type === "write" ? "📄" : "📜";
  const color = type === "write" ? "#27ae60" : "#3498db";

  if (opacity <= 0) return null;

  return (
    <group ref={groupRef} position={[position[0], position[1] + 1 + floatY, position[2]]}>
      {/* Icon */}
      <Text
        fontSize={0.8}
        color="#ffffff"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.02}
        outlineColor={color}
      >
        {icon}
      </Text>

      {/* Filename label */}
      <Text
        position={[0, -0.6, 0]}
        fontSize={0.2}
        color={color}
        anchorX="center"
        anchorY="middle"
      >
        {filename.length > 15 ? filename.slice(0, 12) + "..." : filename}
      </Text>

      {/* Glow effect */}
      <mesh position={[0, 0, -0.1]}>
        <circleGeometry args={[0.5 * scale, 16]} />
        <meshBasicMaterial color={color} transparent opacity={opacity * 0.3} />
      </mesh>
    </group>
  );
}

// ============================================================================
// File Operation Manager Hook
// Manages active file operations for agents
// ============================================================================

interface ActiveFileOperation {
  agentId: string;
  type: "read" | "write";
  filename: string;
  position: [number, number, number];
  timestamp: number;
}

const activeOperations = new Map<string, ActiveFileOperation>();

export function useFileOperations() {
  const [operations, setOperations] = useState<ActiveFileOperation[]>([]);

  const addOperation = (
    agentId: string,
    type: "read" | "write",
    filename: string,
    position: [number, number, number]
  ) => {
    const operation: ActiveFileOperation = {
      agentId,
      type,
      filename,
      position,
      timestamp: Date.now(),
    };
    const key = `${agentId}-${Date.now()}`;
    activeOperations.set(key, operation);
    setOperations((prev) => [...prev, operation]);

    // Remove after animation
    setTimeout(() => {
      activeOperations.delete(key);
      setOperations((prev) => prev.filter((op) => op !== operation));
    }, 2500);
  };

  return {
    operations,
    addOperation,
  };
}

// ============================================================================
// File Operation Pool Component
// Renders all active file operations in the scene
// ============================================================================

interface FileOperationPoolProps {
  operations: ActiveFileOperation[];
}

export function FileOperationPool({ operations }: FileOperationPoolProps) {
  return (
    <>
      {operations.map((op, index) => (
        <FileOperation
          key={`${op.agentId}-${op.timestamp}-${index}`}
          position={op.position}
          type={op.type}
          filename={op.filename}
        />
      ))}
    </>
  );
}
