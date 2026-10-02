import { useId } from 'react';
import type { CSSProperties } from 'react';
import { agentIdentity, agentPalettes, agentSilhouettes } from './agent-identity';
import './agent-avatar.css';

type Props = { name: string; id?: string; size?: 'sm' | 'md' | 'lg' | 'hero'; className?: string };

const smiles = ['M39 68c5 7 16 7 22 0', 'M40 70c5 4 13 4 19-2', 'M42 68c1 6 13 8 17 0', 'M39 68c4 5 13 6 20 1'];
const marks = [
  'M50 23c-2 4-6 7-6 10a6 6 0 0 0 12 0c0-3-4-6-6-10Z',
  'M41 26h5v12h-5zM51 23h5v12h-5z',
  'm50 22 8 9-8 9-8-9Z',
  'M42 36c-1-10 6-15 16-13 0 10-6 16-16 13Z',
  'm50 22 3 6 7 1-5 5 1 7-6-4-6 4 1-7-5-5 7-1Z',
  'M39 32c5-8 17-8 22 0l-3 4c-4-5-12-5-16 0Z',
  'M44 27a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm-6 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  'M44 23c5 1 10 6 10 11-6 0-11-4-10-11Zm13 12c3 1 5 4 4 7-4 0-6-3-4-7Z',
];

// Original blob artwork. Traits are identity cues, never runtime health or approval.
// The adjacent agent name provides the accessible identity; state remains separate.
export default function AgentAvatar({ name, id, size = 'md', className = '' }: Props) {
  const uid = useId().replaceAll(':', '');
  const identity = agentIdentity(name, id);
  const [light, mid, deep, accent] = agentPalettes[identity.palette];
  const body = agentSilhouettes[identity.silhouette];
  const leftEye = 50 - identity.eyeSpacing / 2;
  const rightEye = 50 + identity.eyeSpacing / 2;
  const colors = { '--avatar-light': light, '--avatar-mid': mid, '--avatar-deep': deep, '--avatar-accent': accent } as CSSProperties;
  const fingerprint = `${identity.palette}-${identity.silhouette}-${identity.eyes}-${identity.smile}-${identity.mark}-${Number(identity.mirrored)}-${identity.faceTilt}-${identity.eyeSpacing}`;
  return <span className={`agent-avatar agent-avatar--${size} ${className}`} style={colors} data-avatar-identity={fingerprint} aria-hidden="true">
    <svg viewBox="0 0 100 112" fill="none" focusable="false">
      <defs>
        <linearGradient id={`${uid}-body`} x1="24" y1="12" x2="74" y2="94" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--avatar-light)" /><stop offset=".5" stopColor="var(--avatar-mid)" /><stop offset="1" stopColor="var(--avatar-deep)" />
        </linearGradient>
        <radialGradient id={`${uid}-light`} cx="0" cy="0" r="1" gradientTransform="translate(30 29) rotate(47) scale(59 48)" gradientUnits="userSpaceOnUse">
          <stop stopColor="white" stopOpacity=".42" /><stop offset="1" stopColor="white" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="49" cy="105" rx="26" ry="3" fill="var(--avatar-shadow)" />
      <g transform={identity.mirrored ? 'translate(100 0) scale(-1 1)' : undefined}>
        <path className="agent-avatar-body" d={body} fill={`url(#${uid}-body)`} stroke="var(--avatar-outline)" strokeWidth=".7" />
        <path className="agent-avatar-highlight" d={body} fill={`url(#${uid}-light)`} />
      </g>
      <g transform={`rotate(${identity.faceTilt} 50 61)`}>
        <path className="agent-avatar-mark" d={marks[identity.mark]} fill="var(--avatar-accent)" fillOpacity=".88" />
        <g fill="var(--avatar-face)" stroke="var(--avatar-face)" strokeWidth="3.3" strokeLinecap="round">
          {identity.eyes === 0 && <><circle cx={leftEye} cy="56" r="2.4" stroke="none" /><circle cx={rightEye} cy="56" r="2.4" stroke="none" /></>}
          {identity.eyes === 1 && <><path d={`M${leftEye} 54v3M${rightEye} 54v3`} /><circle cx={leftEye + .5} cy="53.5" r=".8" fill="var(--avatar-accent)" stroke="none" /></>}
          {identity.eyes === 2 && <><path d={`M${leftEye - 2} 57q2-4 4 0M${rightEye - 2} 57q2-4 4 0`} fill="none" /></>}
          {identity.eyes === 3 && <><ellipse cx={leftEye} cy="56" rx="2.2" ry="3.2" stroke="none" /><ellipse cx={rightEye} cy="56" rx="2.2" ry="3.2" stroke="none" /></>}
          <path d={smiles[identity.smile]} fill="none" />
        </g>
      </g>
    </svg>
  </span>;
}
