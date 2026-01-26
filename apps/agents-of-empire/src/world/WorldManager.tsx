import { useMemo, useRef, useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import { InstancedMesh, Vector3, Color, Object3D } from "three";
import { useGameStore, useTilesShallow } from "../store/gameStore";

// ============================================================================
// Types
// ============================================================================

export interface PathNode {
  x: number;
  z: number;
  g: number; // Cost from start
  h: number; // Heuristic to end
  f: number; // g + h
  parent: PathNode | null;
}

// ============================================================================
// Terrain Tile Component
// ============================================================================

interface TerrainTileProps {
  position: [number, number, number];
  type: "grass" | "dirt" | "stone" | "water" | "path";
  walkable: boolean;
}

export function TerrainTile({ position, type, walkable }: TerrainTileProps) {
  const getColor = () => {
    switch (type) {
      case "grass":
        return new Color().setHSL(0.3, 0.6, 0.4);
      case "dirt":
        return new Color().setHSL(0.08, 0.5, 0.35);
      case "stone":
        return new Color().setHSL(0, 0, 0.4);
      case "water":
        return new Color().setHSL(0.6, 0.7, 0.4);
      case "path":
        return new Color().setHSL(0.08, 0.3, 0.5);
      default:
        return new Color(0.3, 0.5, 0.3);
    }
  };

  return (
    <mesh position={position} receiveShadow>
      <boxGeometry args={[1, 0.2, 1]} />
      <meshStandardMaterial color={getColor()} />
    </mesh>
  );
}

// ============================================================================
// World Grid Component (Instanced for performance)
// ============================================================================

interface WorldGridProps {
  width?: number;
  height?: number;
}

export function WorldGrid({ width = 50, height = 50 }: WorldGridProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const tilesMap = useTilesShallow() as Map<string, { type: string; walkable: boolean; x: number; z: number }>;
  // Use a ref to store tiles for useFrame to avoid re-renders
  const tilesRef = useRef(tilesMap);

  // Update ref when tiles change
  useEffect(() => {
    tilesRef.current = tilesMap;
  }, [tilesMap]);

  // Initialize tiles if not already done
  useEffect(() => {
    const state = useGameStore.getState();
    if (state.tiles.size === 0) {
      state.initializeWorld(width, height);
    }
  }, [width, height]);

  const instanceCount = width * height;
  const dummy = useMemo(() => new Object3D(), []);

  // Update instances
  useFrame(() => {
    if (!meshRef.current) return;

    const color = new Color();
    let index = 0;
    const tiles = tilesRef.current; // Use ref value to avoid subscription

    for (let x = 0; x < width; x++) {
      for (let z = 0; z < height; z++) {
        const key = `${x},${z}`;
        const tile = tiles.get(key);

        if (tile) {
          dummy.position.set(x + 0.5, -0.1, z + 0.5);
          dummy.updateMatrix();
          meshRef.current.setMatrixAt(index, dummy.matrix);

          // Set color based on tile type
          switch (tile.type) {
            case "grass":
              color.setHSL(0.3, 0.5, 0.35 + Math.random() * 0.05);
              break;
            case "dirt":
              color.setHSL(0.08, 0.4, 0.3);
              break;
            case "stone":
              color.setHSL(0, 0, 0.35);
              break;
            case "water":
              color.setHSL(0.6, 0.6, 0.45);
              break;
            case "path":
              color.setHSL(0.08, 0.2, 0.45);
              break;
            default:
              color.setRGB(0.3, 0.5, 0.3);
          }

          meshRef.current.setColorAt(index, color);
        }
        index++;
      }
    }

    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) {
      meshRef.current.instanceColor.needsUpdate = true;
    }
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, instanceCount]}
      receiveShadow
    >
      <boxGeometry args={[1, 0.2, 1]} />
      <meshStandardMaterial />
    </instancedMesh>
  );
}

// ============================================================================
// A* Pathfinding
// ============================================================================

export function findPath(
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
  tiles: Map<string, { walkable: boolean }>,
  width: number,
  height: number
): [number, number][] | null {
  // Simple A* pathfinding
  const openSet: PathNode[] = [];
  const closedSet = new Set<string>();

  const startNode: PathNode = {
    x: startX,
    z: startZ,
    g: 0,
    h: 0,
    f: 0,
    parent: null,
  };

  startNode.h = Math.abs(endX - startX) + Math.abs(endZ - startZ);
  startNode.f = startNode.g + startNode.h;

  openSet.push(startNode);

  while (openSet.length > 0) {
    // Find node with lowest f
    openSet.sort((a, b) => a.f - b.f);
    const current = openSet.shift()!;

    // Check if reached goal
    if (current.x === endX && current.z === endZ) {
      const path: [number, number][] = [];
      let node: PathNode | null = current;
      while (node) {
        path.unshift([node.x, node.z]);
        node = node.parent;
      }
      return path;
    }

    closedSet.add(`${current.x},${current.z}`);

    // Check neighbors
    const neighbors = [
      { x: current.x + 1, z: current.z },
      { x: current.x - 1, z: current.z },
      { x: current.x, z: current.z + 1 },
      { x: current.x, z: current.z - 1 },
      // Diagonals
      { x: current.x + 1, z: current.z + 1 },
      { x: current.x - 1, z: current.z - 1 },
      { x: current.x + 1, z: current.z - 1 },
      { x: current.x - 1, z: current.z + 1 },
    ];

    for (const neighbor of neighbors) {
      // Check bounds
      if (
        neighbor.x < 0 ||
        neighbor.x >= width ||
        neighbor.z < 0 ||
        neighbor.z >= height
      ) {
        continue;
      }

      const key = `${neighbor.x},${neighbor.z}`;

      // Check if walkable
      const tile = tiles.get(key);
      if (!tile || !tile.walkable) {
        continue;
      }

      // Check if in closed set
      if (closedSet.has(key)) {
        continue;
      }

      // Calculate g cost (diagonal moves cost more)
      const isDiagonal = neighbor.x !== current.x && neighbor.z !== current.z;
      const g = current.g + (isDiagonal ? 1.414 : 1);

      // Check if neighbor is already in open set
      const existingNode = openSet.find((n) => n.x === neighbor.x && n.z === neighbor.z);

      if (!existingNode) {
        const h = Math.abs(endX - neighbor.x) + Math.abs(endZ - neighbor.z);
        openSet.push({
          x: neighbor.x,
          z: neighbor.z,
          g,
          h,
          f: g + h,
          parent: current,
        });
      } else if (g < existingNode.g) {
        existingNode.g = g;
        existingNode.f = g + existingNode.h;
        existingNode.parent = current;
      }
    }
  }

  // No path found
  return null;
}

// ============================================================================
// World Manager Hook
// ============================================================================

export function useWorldManager() {
  const tiles = useTilesShallow() as Map<string, { type: string; walkable: boolean; x: number; z: number }>;
  const worldSize = useGameStore((state) => state.worldSize);
  const setTile = useGameStore((state) => state.setTile);

  return {
    tiles,
    worldSize,
    setTile,

    // Pathfinding
    findPath: (
      startX: number,
      startZ: number,
      endX: number,
      endZ: number
    ): [number, number][] | null => {
      return findPath(startX, startZ, endX, endZ, tiles, worldSize.width, worldSize.height);
    },

    // Get tile at position
    getTileAt: (x: number, z: number) => {
      return tiles.get(`${x},${z}`);
    },

    // Check if position is walkable
    isWalkable: (x: number, z: number) => {
      const tile = tiles.get(`${x},${z}`);
      return tile?.walkable ?? false;
    },

    // World bounds
    isInBounds: (x: number, z: number) => {
      return x >= 0 && x < worldSize.width && z >= 0 && z < worldSize.height;
    },
  };
}

// ============================================================================
// Ground Plane Component (for raycasting)
// ============================================================================

export function GroundPlane() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[25, -0.1, 25]} receiveShadow>
      <planeGeometry args={[50, 50]} />
      <meshStandardMaterial color="#1a1a2e" transparent opacity={0.8} />
    </mesh>
  );
}
