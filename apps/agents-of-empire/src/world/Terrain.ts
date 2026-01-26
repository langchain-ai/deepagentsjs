import { useEffect } from "react";
import { useGameStore, useTilesShallow, type TileType } from "../store/gameStore";

// ============================================================================
// Terrain Generation Types
// ============================================================================

interface TerrainConfig {
  width: number;
  height: number;
  seed?: number;
}

type Biome = "plains" | "forest" | "mountain" | "water";

// ============================================================================
// Simple Pseudo-Random Number Generator
// ============================================================================

class SeededRandom {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  next(): number {
    this.seed = (this.seed * 9301 + 49297) % 233280;
    return this.seed / 233280;
  }

  nextInRange(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}

// ============================================================================
// Simple Noise Function (Value Noise)
// ============================================================================

class ValueNoise {
  private random: SeededRandom;
  private values: number[][];

  constructor(seed: number, private size: number) {
    this.random = new SeededRandom(seed);
    this.values = [];

    // Generate random values
    for (let x = 0; x <= size; x++) {
      this.values[x] = [];
      for (let y = 0; y <= size; y++) {
        this.values[x][y] = this.random.next();
      }
    }
  }

  // Smooth interpolation
  private smooth(t: number): number {
    return t * t * (3 - 2 * t);
  }

  // Bilinear interpolation
  private interpolate(x: number, y: number): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = x0 + 1;
    const y1 = y0 + 1;

    const sx = this.smooth(x - x0);
    const sy = this.smooth(y - y0);

    const v00 = this.values[x0]?.[y0] ?? 0.5;
    const v10 = this.values[x1]?.[y0] ?? 0.5;
    const v01 = this.values[x0]?.[y1] ?? 0.5;
    const v11 = this.values[x1]?.[y1] ?? 0.5;

    const v0 = v00 * (1 - sx) + v10 * sx;
    const v1 = v01 * (1 - sx) + v11 * sx;

    return v0 * (1 - sy) + v1 * sy;
  }

  // Get noise value at position (octaves for detail)
  getNoise(x: number, y: number, octaves: number = 4): number {
    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let maxValue = 0;

    for (let i = 0; i < octaves; i++) {
      value += this.interpolate(x * frequency, y * frequency) * amplitude;
      maxValue += amplitude;
      amplitude *= 0.5;
      frequency *= 2;
    }

    return value / maxValue;
  }
}

// ============================================================================
// Terrain Generator
// ============================================================================

export function generateTerrain(config: TerrainConfig): Record<string, { x: number; z: number; type: TileType; walkable: boolean }> {
  const { width, height, seed = 12345 } = config;
  const noise = new ValueNoise(seed, Math.max(width, height));
  const tiles: Record<string, { x: number; z: number; type: TileType; walkable: boolean }> = {};

  for (let x = 0; x < width; x++) {
    for (let z = 0; z < height; z++) {
      // Get noise value (0 to 1)
      const noiseValue = noise.getNoise(x / 10, z / 10, 4);

      // Determine biome based on noise
      let type: TileType;
      let walkable = true;

      if (noiseValue < 0.3) {
        type = "grass";
      } else if (noiseValue < 0.5) {
        type = "grass";
      } else if (noiseValue < 0.6) {
        type = "dirt";
      } else if (noiseValue < 0.75) {
        type = "stone";
      } else {
        type = "stone";
      }

      // Add some water pockets
      const waterNoise = noise.getNoise(x / 5 + 100, z / 5 + 100, 2);
      if (waterNoise > 0.7 && noiseValue < 0.4) {
        type = "water";
        walkable = false;
      }

      // Add paths near center (spawn area)
      const centerX = width / 2;
      const centerZ = height / 2;
      const distToCenter = Math.sqrt((x - centerX) ** 2 + (z - centerZ) ** 2);
      if (distToCenter < 5 && type === "grass") {
        type = "path";
      }

      const key = `${x},${z}`;
      tiles[key] = { x, z, type, walkable };
    }
  }

  return tiles;
}

// ============================================================================
// Terrain Component - Initializes and manages the terrain
// ============================================================================

interface TerrainProps {
  config?: TerrainConfig;
}

export function Terrain({ config }: TerrainProps) {
  const initializeWorld = useGameStore((state) => state.initializeWorld);
  const tiles = useTilesShallow() as Record<string, { type: string; walkable: boolean; x: number; z: number }>;

  useEffect(() => {
    // Only initialize if tiles are empty
    if (Object.keys(tiles).length === 0) {
      const defaultConfig: TerrainConfig = {
        width: 50,
        height: 50,
        seed: 12345,
      };

      const generatedTiles = generateTerrain(config ?? defaultConfig);

      // Convert to object and initialize store
      const tilesRecord: Record<string, { x: number; z: number; type: string; walkable: boolean }> = {};
      for (const key in generatedTiles) {
        tilesRecord[key] = generatedTiles[key];
      }

      // Update the store's tiles directly
      useGameStore.setState({ tiles: tilesRecord });

      // Also initialize world size
      const finalConfig = config ?? defaultConfig;
      useGameStore.setState({
        worldSize: { width: finalConfig.width, height: finalConfig.height },
      });
    }
  }, [config, tiles, initializeWorld]);

  return null; // This component doesn't render anything itself
}

// ============================================================================
// Export utilities
// ============================================================================

export function getBiomeAtPosition(x: number, z: number): Biome {
  // Simple biome determination based on position
  const noise = new ValueNoise(12345, 100);
  const value = noise.getNoise(x / 10, z / 10);

  if (value < 0.3) return "plains";
  if (value < 0.6) return "forest";
  if (value < 0.8) return "mountain";
  return "water";
}
