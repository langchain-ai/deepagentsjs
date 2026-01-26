import { useRef, useEffect } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import { Vector3, MathUtils } from "three";
import {
  useCameraPosition,
  useZoom,
  useSetCameraPosition,
  useSetZoom,
} from "../store/gameStore";

// ============================================================================
// Camera Controller Hook
// ============================================================================

interface CameraControllerProps {
  minZoom?: number;
  maxZoom?: number;
  zoomSpeed?: number;
  panSpeed?: number;
  rotation?: number; // In radians, default is Math.PI / 4 for isometric
  elevation?: number; // In radians, default is ~0.615 for classic isometric
}

/**
 * CameraController - Manages the isometric RTS camera
 *
 * Features:
 * - Orthographic projection for isometric view
 * - Zoom with scroll wheel
 * - Pan with edge scrolling or middle-click drag
 * - Smooth damping for all movements
 */
export function useCameraController({
  minZoom = 0.5,
  maxZoom = 3,
  zoomSpeed = 0.001,
  panSpeed = 0.01,
  rotation = Math.PI / 4,
  elevation = Math.asin(Math.tan(Math.PI / 6)),
}: CameraControllerProps = {}) {
  const { camera, gl } = useThree();
  const controlsRef = useRef<{ zoom: number; targetX: number; targetZ: number }>({
    zoom: 1,
    targetX: 25,
    targetZ: 25,
  });

  const position = useCameraPosition();
  const zoom = useZoom();
  const setPosition = useSetCameraPosition();
  const setZoom = useSetZoom();

  // Update zoom from store
  useEffect(() => {
    controlsRef.current.zoom = zoom;
  }, [zoom]);

  // Update position from store
  useEffect(() => {
    controlsRef.current.targetX = position.x;
    controlsRef.current.targetZ = position.z;
  }, [position]);

  // Handle keyboard input for panning
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const panAmount = 2 / controlsRef.current.zoom;

      switch (e.key) {
        case "ArrowLeft":
        case "a":
          setPosition({
            x: Math.max(0, position.x - panAmount),
            y: position.y,
            z: position.z,
          });
          break;
        case "ArrowRight":
        case "d":
          setPosition({
            x: position.x + panAmount,
            y: position.y,
            z: position.z,
          });
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
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [position, setPosition]);

  // Handle mouse wheel for zooming
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = -e.deltaY * zoomSpeed;
      const newZoom = MathUtils.clamp(
        controlsRef.current.zoom + delta * controlsRef.current.zoom,
        minZoom,
        maxZoom
      );
      controlsRef.current.zoom = newZoom;
      setZoom(newZoom);
    };

    const canvas = gl.domElement;
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [gl, zoomSpeed, minZoom, maxZoom, setZoom]);

  // Handle middle mouse drag for panning
  useEffect(() => {
    let isDragging = false;
    let lastX = 0;
    let lastZ = 0;

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 1) {
        // Middle mouse button
        isDragging = true;
        lastX = e.clientX;
        lastZ = e.clientY;
        e.preventDefault();
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;

      const deltaX = e.clientX - lastX;
      const deltaZ = e.clientY - lastZ;

      // Convert screen delta to world delta
      const panAmount = 0.05 / controlsRef.current.zoom;

      const worldDeltaX = (deltaX - deltaZ) * panAmount;
      const worldDeltaZ = (deltaX + deltaZ) * panAmount * 0.5;

      const newX = Math.max(0, position.x - worldDeltaX);
      const newZ = Math.max(0, position.z - worldDeltaZ);

      controlsRef.current.targetX = newX;
      controlsRef.current.targetZ = newZ;
      setPosition({ x: newX, y: position.y, z: newZ });

      lastX = e.clientX;
      lastZ = e.clientY;
    };

    const handleMouseUp = () => {
      isDragging = false;
    };

    const canvas = gl.domElement;
    canvas.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      canvas.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [gl, position, setPosition]);

  // Edge scrolling
  useEffect(() => {
    const EDGE_THRESHOLD = 20;
    const EDGE_SPEED = 0.5 / controlsRef.current.zoom;

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
        const newX = Math.max(0, position.x + edgeX * EDGE_SPEED);
        const newZ = Math.max(0, position.z + edgeZ * EDGE_SPEED);
        controlsRef.current.targetX = newX;
        controlsRef.current.targetZ = newZ;
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

  // Update camera position each frame
  useFrame(() => {
    const zoom = controlsRef.current.zoom;

    // Calculate isometric camera position
    // In isometric view, camera is rotated 45 degrees around Y
    // and elevated ~30-35 degrees from horizontal
    const distance = 40 / zoom;

    const camX = controlsRef.current.targetX + distance * Math.sin(rotation);
    const camY = distance * Math.sin(elevation);
    const camZ = controlsRef.current.targetZ + distance * Math.cos(rotation);

    camera.position.set(camX, camY, camZ);
    camera.lookAt(
      controlsRef.current.targetX,
      0,
      controlsRef.current.targetZ
    );
  });

  return controlsRef;
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
  camera: THREE.Camera,
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
  camera: THREE.Camera,
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
