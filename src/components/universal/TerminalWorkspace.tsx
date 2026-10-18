import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  TerminalDrawer,
  clampTerminalGeom,
  defaultTerminalGeom,
  type TerminalGeom,
} from "./TerminalDrawer";

export interface TerminalWorkspaceProps {
  isOpen: boolean;
  onClose: () => void;
  cwd: string | null;
}

interface TerminalWindowState {
  id: string;
  geom: TerminalGeom;
}

function cascadeGeom(index: number): TerminalGeom {
  const base = defaultTerminalGeom(window.innerWidth, window.innerHeight);
  const offset = (index % 6) * 26;
  return clampTerminalGeom(
    { ...base, x: base.x - offset, y: Math.max(8, base.y - offset) },
    window.innerWidth,
    window.innerHeight
  );
}

/**
 * Owns the set of floating terminal windows. Each TerminalDrawer keeps its own
 * xterm + PTY/WS (so closing one shell never touches the others), while this
 * layer only manages creation, stacking and the shared open/closed state.
 */
export const TerminalWorkspace: React.FC<TerminalWorkspaceProps> = ({ isOpen, onClose, cwd }) => {
  const [windows, setWindows] = useState<TerminalWindowState[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const seqRef = useRef(0);
  const initializedRef = useRef(false);

  const createWindow = useCallback((index: number): TerminalWindowState => {
    seqRef.current += 1;
    return {
      id: `term-${Date.now().toString(36)}-${seqRef.current}`,
      geom: cascadeGeom(index),
    };
  }, []);

  useEffect(() => {
    if (!isOpen || initializedRef.current) return;
    initializedRef.current = true;
    const first = createWindow(0);
    setWindows([first]);
    setActiveId(first.id);
  }, [isOpen, createWindow]);

  const handleNewWindow = useCallback(() => {
    const next = createWindow(windows.length);
    setWindows((prev) => [...prev, next]);
    setActiveId(next.id);
  }, [createWindow, windows.length]);

  const handleCloseWindow = useCallback(
    (id: string) => {
      const next = windows.filter((w) => w.id !== id);
      setWindows(next);
      if (next.length === 0) {
        initializedRef.current = false;
        onClose();
      } else {
        setActiveId((current) => (current === id ? next[next.length - 1].id : current));
      }
    },
    [windows, onClose]
  );

  if (windows.length === 0) return null;

  return (
    <>
      {windows.map((win, index) => (
        <TerminalDrawer
          key={win.id}
          windowId={win.id}
          label={`#${index + 1}`}
          isOpen={isOpen}
          onClose={() => handleCloseWindow(win.id)}
          cwd={cwd}
          zIndex={win.id === activeId ? 48 : 40 + Math.min(index, 5)}
          initialGeom={win.geom}
          active={win.id === activeId}
          onActivate={() => setActiveId(win.id)}
          onNewWindow={handleNewWindow}
        />
      ))}
    </>
  );
};
