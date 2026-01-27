# Camera Controls Reference

## Isometric 3D Camera

The Agents of Empire game features a professional RTS-style isometric camera with full rotation, zoom, and pan controls.

### Default Configuration

- **Default Rotation**: 45 degrees (Math.PI / 4 radians)
- **Default Elevation**: ~35.26 degrees (true isometric angle)
- **Zoom Range**: 0.5x to 3x
- **Smooth Damping**: All camera movements are smoothly interpolated

### Controls

#### Rotation (Orbit around the scene)
- **Q / E Keys**: Rotate left/right
- **Shift + Left/Right Arrow**: Rotate left/right
- **Right-Click + Drag**: Rotate (horizontal movement) and adjust elevation (vertical movement)

#### Elevation (Camera height angle)
- **Home Key**: Increase elevation (camera goes higher)
- **End Key**: Decrease elevation (camera goes lower)
- **Right-Click + Drag (Vertical)**: Adjust elevation

#### Pan (Move camera across the map)
- **WASD Keys**: Pan in all four directions
- **Arrow Keys**: Pan in all four directions
- **Middle Mouse Button + Drag**: Pan (follows camera rotation)
- **Edge Scrolling**: Move mouse to screen edges to pan

#### Zoom
- **Mouse Wheel**: Zoom in/out

### Camera State (Zustand Store)

```typescript
interface CameraState {
  cameraPosition: { x: number; y: number; z: number };
  cameraTarget: { x: number; y: number; z: number };
  zoom: number;
  cameraRotation: number; // Rotation angle around Y axis in radians
  cameraRotationTarget: number; // Target rotation for smooth transitions
  cameraElevation: number; // Elevation angle from horizontal in radians
  cameraElevationTarget: number; // Target elevation for smooth transitions
}
```

### Implementation Details

The camera uses a custom isometric projection calculated each frame:

```typescript
// Camera position calculation
const distance = DISTANCE_BASE / zoom;
const camX = targetX + distance * Math.sin(rotation) * Math.cos(elevation);
const camY = distance * Math.sin(elevation);
const camZ = targetZ + distance * Math.cos(rotation) * Math.cos(elevation);
```

This provides:
- True isometric view at default angles
- Smooth rotation around the scene
- Adjustable elevation angle
- Professional RTS game feel

### Files

- `src/core/CameraController.ts` - Main camera controller implementation
- `src/store/gameStore.ts` - Camera state management
- `src/App.tsx` - Camera component usage
