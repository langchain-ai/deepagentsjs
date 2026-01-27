import { useRef, useCallback, useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import { Vector3, Raycaster, Plane, Camera } from "three";
import { useGameStore, useAgentsShallow, type GameAgent } from "../store/gameStore";

// Get selectedAgentIds from store for checking selection state
const getSelectedAgentIds = () => useGameStore.getState().selectedAgentIds;

// ============================================================================
// Selection Box Types
// ============================================================================

export interface SelectionBox {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  active: boolean;
}

// ============================================================================
// Selection System Hook
// ============================================================================

interface SelectionSystemOptions {
  onAgentsSelected?: (agentIds: string[]) => void;
  onGroundClicked?: (position: [number, number, number]) => void;
  onAgentRightClicked?: (agentId: string, position: { x: number; y: number }) => void;
}

interface DragState {
  isDragging: boolean;
  startX: number;
  startY: number;
  hasMoved: boolean;
  currentX: number;
  currentY: number;
}

export function useSelectionSystem(options: SelectionSystemOptions = {}) {
  const { camera, size } = useThree();
  const raycaster = useRef(new Raycaster());
  const mouse = useRef(new Vector3());
  const groundPlane = useRef(new Plane(new Vector3(0, 1, 0), 0));

  // Use ref for drag state to avoid closure issues
  const dragStateRef = useRef<DragState>({
    isDragging: false,
    startX: 0,
    startY: 0,
    hasMoved: false,
    currentX: 0,
    currentY: 0,
  });

  const agentsMap = useAgentsShallow() as Record<string, GameAgent>;
  const agents = useMemo(() => Object.values(agentsMap), [agentsMap]);
  const selectedAgentIds = useGameStore((state) => state.selectedAgentIds);
  const selectAgent = useGameStore((state) => state.selectAgent);
  const toggleAgentSelection = useGameStore((state) => state.toggleAgentSelection);
  const clearSelection = useGameStore((state) => state.clearSelection);
  const openContextMenu = useGameStore((state) => state.openContextMenu);
  const closeContextMenu = useGameStore((state) => state.closeContextMenu);
  const startSelectionBox = useGameStore((state) => state.startSelectionBox);
  const updateSelectionBox = useGameStore((state) => state.updateSelectionBox);
  const endSelectionBox = useGameStore((state) => state.endSelectionBox);

  // Screen to world coordinates
  const screenToWorld = useCallback(
    (screenX: number, screenY: number): Vector3 | null => {
      const vector = new Vector3();
      vector.set(
        (screenX / size.width) * 2 - 1,
        -(screenY / size.height) * 2 + 1,
        0.5
      );
      vector.unproject(camera);

      const dir = vector.sub(camera.position).normalize();
      const distance = -camera.position.y / dir.y;

      if (distance < 0) return null;

      return camera.position.clone().add(dir.multiplyScalar(distance));
    },
    [camera, size]
  );

  // Raycast to find agent under cursor
  const getAgentAtScreenPos = useCallback(
    (screenX: number, screenY: number) => {
      const vector = new Vector3();
      vector.set(
        (screenX / size.width) * 2 - 1,
        -(screenY / size.height) * 2 + 1,
        0.5
      );

      raycaster.current.setFromCamera(vector, camera);

      // Check intersection with agent positions
      const agentHits: Array<{ id: string; distance: number }> = [];

      for (const agent of agents) {
        const agentPos = new Vector3(...agent.position);
        const distance = agentPos.distanceTo(raycaster.current.ray.origin);

        // Simple proximity check (agent radius ~1 unit)
        if (distance < 3) {
          agentHits.push({ id: agent.id, distance });
        }
      }

      // Sort by distance and return closest
      agentHits.sort((a, b) => a.distance - b.distance);
      return agentHits[0]?.id || null;
    },
    [camera, agents, size]
  );

  // Check if an agent is within a screen-space selection box
  const isAgentInScreenBox = useCallback(
    (agent: GameAgent, box: { startX: number; startY: number; endX: number; endY: number }): boolean => {
      const pos = new Vector3(...agent.position);
      pos.project(camera);

      const screenX = (pos.x * 0.5 + 0.5) * size.width;
      const screenY = ((-pos.y * 0.5) + 0.5) * size.height;

      const minX = Math.min(box.startX, box.endX);
      const maxX = Math.max(box.startX, box.endX);
      const minY = Math.min(box.startY, box.endY);
      const maxY = Math.max(box.startY, box.endY);

      return screenX >= minX && screenX <= maxX && screenY >= minY && screenY <= maxY;
    },
    [camera, size]
  );

  // Select all agents within a screen-space selection box
  const selectAgentsInScreenBox = useCallback(
    (box: { startX: number; startY: number; endX: number; endY: number }) => {
      const selectedIds: string[] = [];

      for (const agent of agents) {
        if (isAgentInScreenBox(agent, box)) {
          selectedIds.push(agent.id);
        }
      }

      // Update store with selected agents
      if (selectedIds.length > 0) {
        // Clear current selection and select new agents
        clearSelection();
        const store = useGameStore.getState();
        for (const id of selectedIds) {
          store.selectAgent(id);
        }
      }

      options.onAgentsSelected?.(selectedIds);
      return selectedIds;
    },
    [agents, isAgentInScreenBox, clearSelection, options]
  );

  // Handle mouse down (start selection or detect click)
  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      const rect = (e.target as HTMLElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Check if clicking on an agent
      const agentId = getAgentAtScreenPos(x, y);

      if (e.button === 0) {
        // Left click
        if (agentId) {
          // Clicking on an agent - handle agent selection
          if (e.shiftKey) {
            // Shift + click = toggle selection
            toggleAgentSelection(agentId);
          } else if (!selectedAgentIds.has(agentId)) {
            // Single click - select this agent, deselect others
            clearSelection();
            selectAgent(agentId);
          }
          options.onAgentsSelected?.([agentId]);
        } else {
          // Clicked on empty space - start drag selection
          dragStateRef.current = {
            isDragging: true,
            startX: x,
            startY: y,
            hasMoved: false,
            currentX: x,
            currentY: y,
          };
          startSelectionBox(x, y);
        }
      } else if (e.button === 2) {
        // Right click
        if (agentId) {
          // Right click on agent - show context menu
          e.preventDefault();
          closeContextMenu();
          openContextMenu({ x: e.clientX, y: e.clientY }, agentId);
          options.onAgentRightClicked?.(agentId, { x: e.clientX, y: e.clientY });
        } else {
          // Right click on ground - move selected agents
          const worldPos = screenToWorld(x, y);
          if (worldPos) {
            closeContextMenu();
            options.onGroundClicked?.([worldPos.x, 0, worldPos.z]);
          }
        }
      }
    },
    [
      agents,
      clearSelection,
      selectAgent,
      toggleAgentSelection,
      getAgentAtScreenPos,
      screenToWorld,
      openContextMenu,
      closeContextMenu,
      startSelectionBox,
      selectedAgentIds,
      options,
    ]
  );

  // Handle mouse move (for drag selection)
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragStateRef.current.isDragging) return;

      const rect = (e.target as HTMLElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Check if we've moved enough to consider this a drag
      const movedDistance = Math.sqrt(
        Math.pow(x - dragStateRef.current.startX, 2) +
        Math.pow(y - dragStateRef.current.startY, 2)
      );

      if (movedDistance > 5) {
        // Minimum drag distance of 5 pixels
        dragStateRef.current.hasMoved = true;
        dragStateRef.current.currentX = x;
        dragStateRef.current.currentY = y;
        updateSelectionBox(x, y);
      }
    },
    [updateSelectionBox]
  );

  // Handle mouse up (end drag selection)
  const handleMouseUp = useCallback(
    (e: MouseEvent) => {
      if (!dragStateRef.current.isDragging) return;

      if (dragStateRef.current.hasMoved) {
        // Complete drag selection
        const box = {
          startX: dragStateRef.current.startX,
          startY: dragStateRef.current.startY,
          endX: dragStateRef.current.currentX,
          endY: dragStateRef.current.currentY,
        };
        selectAgentsInScreenBox(box);
      } else {
        // Was just a click on empty space - deselect all
        clearSelection();
        options.onAgentsSelected?.([]);
      }

      // Reset drag state
      dragStateRef.current = {
        isDragging: false,
        startX: 0,
        startY: 0,
        hasMoved: false,
        currentX: 0,
        currentY: 0,
      };
      endSelectionBox();
    },
    [selectAgentsInScreenBox, clearSelection, endSelectionBox, options]
  );

  // Prevent context menu on right click
  const handleContextMenu = useCallback((e: MouseEvent) => {
    e.preventDefault();
  }, []);

  // Set up event listeners
  useEffect(() => {
    const canvas = camera.domElement || document.querySelector("canvas");

    if (canvas) {
      canvas.addEventListener("mousedown", handleMouseDown);
      canvas.addEventListener("mousemove", handleMouseMove);
      canvas.addEventListener("mouseup", handleMouseUp);
      canvas.addEventListener("contextmenu", handleContextMenu);

      return () => {
        canvas.removeEventListener("mousedown", handleMouseDown);
        canvas.removeEventListener("mousemove", handleMouseMove);
        canvas.removeEventListener("mouseup", handleMouseUp);
        canvas.removeEventListener("contextmenu", handleContextMenu);
      };
    }
  }, [camera, handleMouseDown, handleMouseMove, handleMouseUp, handleContextMenu]);

  return {
    screenToWorld,
    getAgentAtScreenPos,
    isAgentInScreenBox,
    selectAgentsInScreenBox,
  };
}

// ============================================================================
// Selection Box Component (Visual)
// ============================================================================

interface SelectionBoxVisualProps {
  box: SelectionBox;
}

export function SelectionBoxVisual({ box }: SelectionBoxVisualProps) {
  if (!box.active) return null;

  const x = Math.min(box.startX, box.endX);
  const y = Math.min(box.startY, box.endY);
  const width = Math.abs(box.endX - box.startX);
  const height = Math.abs(box.endY - box.startY);

  return (
    <div
      className="selection-box"
      style={{
        left: x,
        top: y,
        width,
        height,
      }}
    />
  );
}

// ============================================================================
// Helper: Check if agent is within selection box
// ============================================================================

export function isAgentInSelectionBox(
  agent: { position: [number, number, number] },
  box: SelectionBox,
  camera: Camera,
  width: number,
  height: number
): boolean {
  const pos = new Vector3(...agent.position);
  pos.project(camera);

  const screenX = (pos.x * 0.5 + 0.5) * width;
  const screenY = (-(pos.y * 0.5) + 0.5) * height;

  const minX = Math.min(box.startX, box.endX);
  const maxX = Math.max(box.startX, box.endX);
  const minY = Math.min(box.startY, box.endY);
  const maxY = Math.max(box.startY, box.endY);

  return screenX >= minX && screenX <= maxX && screenY >= minY && screenY <= maxY;
}

// ============================================================================
// Selection System Component (wrapper for the hook)
// ============================================================================

interface SelectionSystemComponentProps {
  onAgentsSelected?: (agentIds: string[]) => void;
  onGroundClicked?: (position: [number, number, number]) => void;
  onAgentRightClicked?: (agentId: string, position: { x: number; y: number }) => void;
}

export function SelectionSystem(props: SelectionSystemComponentProps) {
  useSelectionSystem(props);
  return null; // This component doesn't render anything, just sets up event listeners
}
