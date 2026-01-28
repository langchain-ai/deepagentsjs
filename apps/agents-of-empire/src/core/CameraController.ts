import { useRef, useEffect } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import { Vector3, MathUtils, Camera as ThreeCamera } from "three";
import {
  useCameraPosition,
  useZoom,
  useSetCameraPosition,
  useSetZoom,
  useCameraRotation,
  useCameraRotationTarget,
  useCameraElevation,
  useCameraElevationTarget,
  useSetCameraRotation,
  useSetCameraElevation,
} from "../store/gameStore";

// ============================================================================
// Camera Controller Hook
// ============================================================================

interface CameraControllerProps {
  minZoom?: number;
  maxZoom?: number;
  zoomSpeed?: number;
  panSpeed?: number;
  rotationSpeed?: number;
  elevationSpeed?: number;
  damping?: number; // Smoothness factor (0-1), higher = smoother
}

// Constants for isometric camera
const MIN_ELEVATION = Math.PI / 8; // 22.5 degrees minimum
const MAX_ELEVATION = Math.PI / 3; // 60 degrees maximum
const DISTANCE_BASE = 40; // Base distance from target
const MIN_CAMERA_HEIGHT = 5; // Minimum camera height to prevent terrain clipping

/**
 * useCameraController - Manages the isometric RTS camera
 *
 * Features:
 * - Isometric projection with 45-degree default angle
 * - Fully rotational camera around the scene
 * - Smooth damping for all camera movements
 * - Zoom with scroll wheel (0.2x to 5.0x range for agent-to-map view)
 * - Pan with edge scrolling, middle-click drag, or WASD/arrow keys
 * - Rotate with Q/E keys or right-click drag
 * - Adjust elevation with Home/End keys
 *
 * Zoom Levels:
 * - 5.0x: Full map overview (50x50 tiles visible)
 * - 2.0x: Standard tactical view (default)
 * - 1.0x: Medium-close view (multiple agents)
 * - 0.5x: Close view (single agent detail)
 * - 0.2x: Extreme close-up (agent inspection)
 */
export function useCameraController({
  minZoom = 0.2,
  maxZoom = 5.0,
  zoomSpeed = 0.002,
  panSpeed = 0.01,
  rotationSpeed = 0.02,
  elevationSpeed = 0.01,
  damping = 0.1,
}: CameraControllerProps = {}) {
  const { camera, gl } = useThree();

  // Get current state from store
  const position = useCameraPosition();
  const zoom = useZoom();
  const rotation = useCameraRotation();
  const rotationTarget = useCameraRotationTarget();
  const elevation = useCameraElevation();
  const elevationTarget = useCameraElevationTarget();

  // Get setters
  const setPosition = useSetCameraPosition();
  const setZoom = useSetZoom();
  const setRotation = useSetCameraRotation();
  const setElevation = useSetCameraElevation();

  // Local ref for smooth interpolation values
  const smoothRef = useRef<{
    currentX: number;
    currentZ: number;
    currentZoom: number;
    currentRotation: number;
    currentElevation: number;
  }>({
    currentX: position.x,
    currentZ: position.z,
    currentZoom: zoom,
    currentRotation: rotation,
    currentElevation: elevation,
  });

  // Update smooth values when target changes (for direct set operations)
  useEffect(() => {
    smoothRef.current.currentX = position.x;
    smoothRef.current.currentZ = position.z;
  }, [position]);

  // Handle keyboard input for camera control
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Get current smooth zoom for panning calculations
      const currentZoom = smoothRef.current.currentZoom;
      const panAmount = 2 / currentZoom;

      switch (e.key) {
        case "ArrowLeft":
        case "a":
          // Rotate camera if holding Shift, otherwise pan
          if (e.shiftKey) {
            setRotation(rotationTarget + rotationSpeed);
          } else {
            setPosition({
              x: Math.max(0, position.x - panAmount),
              y: position.y,
              z: position.z,
            });
          }
          break;
        case "ArrowRight":
        case "d":
          // Rotate camera if holding Shift, otherwise pan
          if (e.shiftKey) {
            setRotation(rotationTarget - rotationSpeed);
          } else {
            setPosition({
              x: position.x + panAmount,
              y: position.y,
              z: position.z,
            });
          }
          break;
        case "ArrowUp":
        case "w":
          setPosition({
            x: position.x,
            y: position.y,
            z: Math.max(0, position.z - panAmount),
          });
          break;
        case "ArrowDown":
        case "s":
          setPosition({
            x: position.x,
            y: position.y,
            z: position.z + panAmount,
          });
          break;
        case "q":
        case "Q":
          // Rotate left
          setRotation(rotationTarget + rotationSpeed);
          break;
        case "e":
        case "E":
          // Rotate right
          setRotation(rotationTarget - rotationSpeed);
          break;
        case "Home":
          // Increase elevation
          setElevation(Math.min(MAX_ELEVATION, elevationTarget + elevationSpeed));
          break;
        case "End":
          // Decrease elevation
          setElevation(Math.max(MIN_ELEVATION, elevationTarget - elevationSpeed));
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [position, rotationTarget, elevationTarget, setPosition, setRotation, setElevation, rotationSpeed, elevationSpeed]);

  // Handle mouse wheel for zooming
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = -e.deltaY * zoomSpeed;
      const newZoom = MathUtils.clamp(
        smoothRef.current.currentZoom + delta * smoothRef.current.currentZoom,
        minZoom,
        maxZoom
      );
      smoothRef.current.currentZoom = newZoom;
      setZoom(newZoom);
    };

    const canvas = gl.domElement;
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [gl, zoomSpeed, minZoom, maxZoom, setZoom]);

  // Handle middle mouse drag for panning and right mouse drag for rotation
  useEffect(() => {
    let isPanning = false;
    let isRotating = false;
    let lastX = 0;
    let lastY = 0;

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 1) {
        // Middle mouse button - pan
        isPanning = true;
        lastX = e.clientX;
        lastY = e.clientY;
        e.preventDefault();
      } else if (e.button === 2) {
        // Right mouse button - rotate
        isRotating = true;
        lastX = e.clientX;
        lastY = e.clientY;
        e.preventDefault();
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (isPanning) {
        const deltaX = e.clientX - lastX;
        const deltaY = e.clientY - lastY;

        // Convert screen delta to world delta based on current rotation
        const currentRotation = smoothRef.current.currentRotation;
        const panAmount = 0.05 / smoothRef.current.currentZoom;

        // Calculate pan direction based on camera rotation
        const cos = Math.cos(currentRotation);
        const sin = Math.sin(currentRotation);

        const worldDeltaX = (deltaX * cos - deltaY * sin) * panAmount;
        const worldDeltaZ = (deltaX * sin + deltaY * cos) * panAmount;

        const newX = Math.max(0, position.x - worldDeltaX);
        const newZ = Math.max(0, position.z - worldDeltaZ);

        smoothRef.current.currentX = newX;
        smoothRef.current.currentZ = newZ;
        setPosition({ x: newX, y: position.y, z: newZ });

        lastX = e.clientX;
        lastY = e.clientY;
      } else if (isRotating) {
        const deltaX = e.clientX - lastX;
        const deltaY = e.clientY - lastY;

        // Horizontal movement = rotation
        const newRotation = rotationTarget + deltaX * rotationSpeed * 0.5;
        setRotation(newRotation);

        // Vertical movement = elevation
        const newElevation = MathUtils.clamp(
          elevationTarget - deltaY * elevationSpeed * 0.5,
          MIN_ELEVATION,
          MAX_ELEVATION
        );
        setElevation(newElevation);

        lastX = e.clientX;
        lastY = e.clientY;
      }
    };

    const handleMouseUp = () => {
      isPanning = false;
      isRotating = false;
    };

    const handleContextMenu = (e: Event) => {
      // Prevent context menu on right-click
      e.preventDefault();
    };

    const canvas = gl.domElement;
    canvas.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    canvas.addEventListener("contextmenu", handleContextMenu);

    return () => {
      canvas.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      canvas.removeEventListener("contextmenu", handleContextMenu);
    };
  }, [gl, position, rotationTarget, elevationTarget, setPosition, setRotation, setElevation, rotationSpeed, elevationSpeed]);

  // Edge scrolling
  useEffect(() => {
    const EDGE_THRESHOLD = 20;
    const EDGE_SPEED = 0.5 / smoothRef.current.currentZoom;

    let edgeX = 0;
    let edgeZ = 0;

    const handleMouseMove = (e: MouseEvent) => {
      const x = e.clientX;
      const y = e.clientY;
      const width = window.innerWidth;
      const height = window.innerHeight;

      edgeX = 0;
      edgeZ = 0;

      if (x < EDGE_THRESHOLD) edgeX = -1;
      if (x > width - EDGE_THRESHOLD) edgeX = 1;
      if (y < EDGE_THRESHOLD) edgeZ = -1;
      if (y > height - EDGE_THRESHOLD) edgeZ = 1;
    };

    window.addEventListener("mousemove", handleMouseMove);

    let animationFrameId: number;
    const updateEdgeScroll = () => {
      if (edgeX !== 0 || edgeZ !== 0) {
        const currentRotation = smoothRef.current.currentRotation;
        const panAmount = EDGE_SPEED;

        // Calculate pan direction based on camera rotation
        const cos = Math.cos(currentRotation);
        const sin = Math.sin(currentRotation);

        const worldDeltaX = (edgeX * cos - edgeZ * sin) * panAmount;
        const worldDeltaZ = (edgeX * sin + edgeZ * cos) * panAmount;

        const newX = Math.max(0, position.x + worldDeltaX);
        const newZ = Math.max(0, position.z + worldDeltaZ);

        smoothRef.current.currentX = newX;
        smoothRef.current.currentZ = newZ;
        setPosition({ x: newX, y: position.y, z: newZ });
      }
      animationFrameId = requestAnimationFrame(updateEdgeScroll);
    };

    updateEdgeScroll();

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      cancelAnimationFrame(animationFrameId);
    };
  }, [position, setPosition]);

  // Update camera position each frame with smooth damping
  useFrame(() => {
    // Smoothly interpolate all values towards targets
    const smoothFactor = 1 - Math.pow(1 - damping, 1 / 60); // Frame-rate independent

    // Interpolate position
    smoothRef.current.currentX += (position.x - smoothRef.current.currentX) * smoothFactor;
    smoothRef.current.currentZ += (position.z - smoothRef.current.currentZ) * smoothFactor;

    // Interpolate zoom
    smoothRef.current.currentZoom += (zoom - smoothRef.current.currentZoom) * smoothFactor;

    // Interpolate rotation
    smoothRef.current.currentRotation += (rotationTarget - smoothRef.current.currentRotation) * smoothFactor;

    // Interpolate elevation
    smoothRef.current.currentElevation += (elevationTarget - smoothRef.current.currentElevation) * smoothFactor;

    // Calculate isometric camera position
    const distance = DISTANCE_BASE / smoothRef.current.currentZoom;
    const currentRotation = smoothRef.current.currentRotation;
    const currentElevation = smoothRef.current.currentElevation;

    const camX = smoothRef.current.currentX + distance * Math.sin(currentRotation) * Math.cos(currentElevation);
    const camY = distance * Math.sin(currentElevation);
    const camZ = smoothRef.current.currentZ + distance * Math.cos(currentRotation) * Math.cos(currentElevation);

    // Clamp camera height to prevent clipping through terrain
    const clampedCamY = Math.max(MIN_CAMERA_HEIGHT, camY);

    camera.position.set(camX, clampedCamY, camZ);
    camera.lookAt(
      smoothRef.current.currentX,
      0,
      smoothRef.current.currentZ
    );
  });

  return smoothRef;
}

// ============================================================================
// Camera Controller Component
// ============================================================================

export function CameraController(props: CameraControllerProps) {
  useCameraController(props);
  return null;
}

// ============================================================================
// World Position to Screen Position Helper
// ============================================================================

export function worldToScreen(
  worldPos: Vector3,
  camera: ThreeCamera,
  width: number,
  height: number
): { x: number; y: number } {
  const vector = worldPos.clone();
  vector.project(camera);

  return {
    x: (vector.x * 0.5 + 0.5) * width,
    y: (-(vector.y * 0.5) + 0.5) * height,
  };
}

// ============================================================================
// Screen Position to World Position Helper (Raycast to ground plane)
// ============================================================================

export function screenToWorld(
  screenX: number,
  screenY: number,
  camera: ThreeCamera,
  width: number,
  height: number
): Vector3 | null {
  const vector = new Vector3();
  vector.set(
    (screenX / width) * 2 - 1,
    -(screenY / height) * 2 + 1,
    0.5
  );

  vector.unproject(camera);

  const dir = vector.sub(camera.position).normalize();
  const distance = -camera.position.y / dir.y;

  if (distance < 0) return null;

  return camera.position.clone().add(dir.multiplyScalar(distance));
}
