import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { boundedWidth, defaultLayout, layoutLimits, layoutStorageKey, normalizeLayout, readLayout, serializeLayout } from './layout-preferences';
import type { InspectorDock, LayoutGeometry } from './layout-preferences';
import './layout-preferences.css';

type LayoutContextValue = LayoutGeometry & {
  effectiveInspectorWidth: number; inspectorResizeMax: number;
  setSidebarWidth: (value: number) => void; setInspectorWidth: (value: number) => void;
  setInspectorDock: (value: InspectorDock) => void; showInspector: () => void;
  hideInspector: () => void; resetLayout: () => void;
};
const nothing = () => {};
const LayoutContext = createContext<LayoutContextValue>({ ...defaultLayout, effectiveInspectorWidth: 340, inspectorResizeMax: 520, setSidebarWidth: nothing, setInspectorWidth: nothing, setInspectorDock: nothing, showInspector: nothing, hideInspector: nothing, resetLayout: nothing });
export const useLayoutPreferences = () => useContext(LayoutContext);

export function LayoutProvider({ userId, organizationId, children }: { userId: string; organizationId: string; children: ReactNode }) {
  const key = layoutStorageKey(userId, organizationId);
  return <ScopedLayoutProvider key={key} storageKey={key}>{children}</ScopedLayoutProvider>;
}

function ScopedLayoutProvider({ storageKey, children }: { storageKey: string; children: ReactNode }) {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [geometry, setGeometry] = useState<LayoutGeometry>(() => {
    try { return readLayout(localStorage.getItem(storageKey)); } catch { return { ...defaultLayout }; }
  });
  const current = useRef(geometry); current.current = geometry;
  useEffect(() => {
    const resized = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', resized);
    return () => window.removeEventListener('resize', resized);
  }, []);
  useEffect(() => {
    const save = () => { try { localStorage.setItem(storageKey, serializeLayout(current.current)); } catch { /* Storage is optional. */ } };
    const timer = window.setTimeout(save, 120);
    return () => { window.clearTimeout(timer); save(); };
  }, [geometry, storageKey]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) setGeometry(readLayout(event.key === null ? null : event.newValue));
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [storageKey]);
  const setSidebarWidth = useCallback((value: number) => setGeometry(old => ({ ...old, sidebarWidth: boundedWidth(value, layoutLimits.sidebar.min, layoutLimits.sidebar.max, layoutLimits.sidebar.initial) })), []);
  const setInspectorWidth = useCallback((value: number) => setGeometry(old => ({ ...old, inspectorWidth: boundedWidth(value, layoutLimits.inspector.min, layoutLimits.inspector.max, layoutLimits.inspector.initial) })), []);
  const setInspectorDock = useCallback((value: InspectorDock) => setGeometry(old => normalizeLayout({ ...old, inspectorDock: value, inspectorSide: value === 'hidden' ? old.inspectorSide : value })), []);
  const showInspector = useCallback(() => setGeometry(old => ({ ...old, inspectorDock: old.inspectorSide })), []);
  const hideInspector = useCallback(() => setGeometry(old => ({ ...old, inspectorDock: 'hidden' })), []);
  const resetLayout = useCallback(() => setGeometry({ ...defaultLayout }), []);
  // Retain the preferred width while keeping the central task usable on smaller
  // desktops. Mobile uses its existing stacked layout and hides resize handles.
  const inspectorResizeMax = Math.min(520, Math.max(280, viewportWidth - geometry.sidebarWidth - 440));
  const effectiveInspectorWidth = Math.min(geometry.inspectorWidth, inspectorResizeMax);
  const style = { '--company-rail': `${geometry.sidebarWidth}px`, '--task-inspector-width': `${effectiveInspectorWidth}px` } as CSSProperties;
  return <LayoutContext.Provider value={{ ...geometry, effectiveInspectorWidth, inspectorResizeMax, setSidebarWidth, setInspectorWidth, setInspectorDock, showInspector, hideInspector, resetLayout }}>
    <div className="layout-preferences" data-inspector-dock={geometry.inspectorDock} style={style}>{children}</div>
  </LayoutContext.Provider>;
}
