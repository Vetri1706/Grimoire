export type InspectorSide = 'left' | 'right';
export type InspectorDock = InspectorSide | 'hidden';
export type LayoutGeometry = { sidebarWidth: number; inspectorWidth: number; inspectorDock: InspectorDock; inspectorSide: InspectorSide };
export const layoutLimits = { sidebar: { min: 208, max: 420, initial: 270 }, inspector: { min: 280, max: 520, initial: 340 } } as const;
export const defaultLayout: LayoutGeometry = { sidebarWidth: 270, inspectorWidth: 340, inspectorDock: 'right', inspectorSide: 'right' };

export function boundedWidth(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

export function normalizeLayout(value: unknown): LayoutGeometry {
  const data = value && typeof value === 'object' ? value as Partial<LayoutGeometry> : {};
  const dock = data.inspectorDock === 'left' || data.inspectorDock === 'hidden' ? data.inspectorDock : 'right';
  return {
    sidebarWidth: boundedWidth(data.sidebarWidth, 208, 420, 270),
    inspectorWidth: boundedWidth(data.inspectorWidth, 280, 520, 340),
    inspectorDock: dock,
    inspectorSide: dock === 'hidden' ? data.inspectorSide === 'left' ? 'left' : 'right' : dock,
  };
}

export function layoutStorageKey(userId: string, organizationId: string): string {
  return `grimoire:layout:v1:${encodeURIComponent(userId)}:${encodeURIComponent(organizationId)}`;
}

export function readLayout(raw: string | null): LayoutGeometry {
  try { return normalizeLayout(raw ? JSON.parse(raw) : null); } catch { return { ...defaultLayout }; }
}

export function serializeLayout(value: LayoutGeometry): string {
  // Whitelist geometry only. Never persist task/source content or account tokens.
  return JSON.stringify(normalizeLayout(value));
}

export function resizeFromKey(key: string, value: number, direction: 1 | -1, min: number, max: number, initial: number, largeStep = false): number | null {
  if (key === 'Home') return min;
  if (key === 'End') return max;
  if (key === 'Enter') return initial;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  return boundedWidth(value + (key === 'ArrowRight' ? 1 : -1) * direction * (largeStep ? 32 : 8), min, max, initial);
}
