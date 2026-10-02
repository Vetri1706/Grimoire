import { useRef, useState } from 'react';
import { boundedWidth, resizeFromKey } from './layout-preferences';

type Props = { label: string; value: number; min: number; max: number; initial: number; direction?: 1 | -1; onChange: (value: number) => void; className?: string; controls?: string };

export default function LayoutResizeHandle({ label, value, min, max, initial, direction = 1, onChange, className = '', controls }: Props) {
  const drag = useRef<{ x: number; width: number; pointerId: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  return <div role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`${value} pixels`} aria-controls={controls}
    className={`layout-resize-handle ${className}`} data-resizing={resizing} title="Drag to resize. Use arrow keys, Home or End. Press Enter or double-click to reset."
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, width: value, pointerId: event.pointerId }; setResizing(true);
    }}
    onPointerMove={event => { if (drag.current?.pointerId === event.pointerId) onChange(boundedWidth(drag.current.width + (event.clientX - drag.current.x) * direction, min, max, initial)); }}
    onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) { drag.current = null; setResizing(false); event.currentTarget.releasePointerCapture(event.pointerId); } }}
    onPointerCancel={() => { if (drag.current) onChange(drag.current.width); drag.current = null; setResizing(false); }}
    onLostPointerCapture={() => { drag.current = null; setResizing(false); }}
    onDoubleClick={() => onChange(initial)}
    onKeyDown={event => {
      if (event.key === 'Escape' && drag.current) { onChange(drag.current.width); drag.current = null; setResizing(false); event.preventDefault(); return; }
      const next = resizeFromKey(event.key, value, direction, min, max, initial, event.shiftKey);
      if (next !== null) { event.preventDefault(); onChange(next); }
    }}><span aria-hidden="true" /></div>;
}
