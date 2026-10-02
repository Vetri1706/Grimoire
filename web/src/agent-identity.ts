// Stable visual identity only. None of these traits represent runtime or approval state.
// Keep the palette and shape ordering stable so an agent keeps its character after updates.
export const agentPalettes = [
  ['#a8eee4', '#50c4ce', '#267d9e', '#e7fff4'],
  ['#bee8ff', '#78b8ef', '#456aca', '#eef6ff'],
  ['#d5c7ff', '#ad96e8', '#755bb6', '#fff0dc'],
  ['#b7f0dd', '#68cdb5', '#318f8c', '#f0ffd2'],
  ['#fbd1e5', '#ec92bd', '#ab5994', '#fff4d8'],
  ['#ffdfb3', '#efb574', '#b57856', '#fff4de'],
  ['#d2e9ad', '#a6ce83', '#638e73', '#fff6d4'],
  ['#c7ddff', '#96a9ef', '#646abb', '#e7fff5'],
  ['#f6c6bd', '#e99e96', '#b36981', '#fff0cf'],
  ['#b9edf1', '#65cddc', '#4285bd', '#fff4d6'],
  ['#eacdf5', '#c498dc', '#8764ab', '#e5ffec'],
  ['#f8e6a8', '#dfc77a', '#9c965e', '#f5fcde'],
  ['#ade7d3', '#69bcaa', '#43888c', '#f8f0ce'],
  ['#ffcdb5', '#efa67b', '#b97c80', '#fff6de'],
  ['#c1dded', '#88b8d4', '#557ba5', '#f8edff'],
  ['#e0d1fb', '#c0a9ec', '#8b75b8', '#e7fff9'],
  ['#d6f0ca', '#92d3a2', '#5e9e92', '#fdf3d1'],
  ['#f5cadd', '#d39dbd', '#9d719f', '#e8fff5'],
  ['#b3e0ff', '#72c0e5', '#527faf', '#fff2dc'],
  ['#e8e3b8', '#bec787', '#879e77', '#fff4db'],
  ['#f7cfcb', '#dd9fab', '#a5658a', '#fff2d1'],
  ['#c3efec', '#82c6d3', '#6283b6', '#fff8df'],
  ['#d6cefa', '#afa3dc', '#7a74b1', '#e6faff'],
  ['#ffe5c7', '#e8bda0', '#b68c91', '#edfbea'],
] as const;

// Original, softly asymmetric silhouettes, all sharing a readable central face area.
export const agentSilhouettes = [
  'M79 8C61 7 38 13 25 27 11 41 8 60 14 76c6 16 19 23 35 23 24 0 40-17 40-39 0-13-8-23-10-33-1-7 9-16 0-19Z',
  'M31 10C47 7 60 19 72 24c15 7 20 24 18 41-2 22-17 35-39 35-25 0-41-14-41-35 0-16 12-26 15-37 2-8-3-16 6-18Z',
  'M47 12c16-5 33 1 39 16 5 12 3 22 5 34 3 22-8 36-29 39-22 3-44-4-50-23-5-17 0-33 8-47 6-10 15-16 27-19Z',
  'M38 9c10 0 11 13 20 13 7 0 14-8 21-2 10 9 12 24 12 42 0 22-15 37-38 38-22 0-41-12-42-32-2-16 5-28 12-37 6-9 5-22 15-22Z',
  'M61 13c18 2 24 18 24 29 0 12 9 19 7 32-3 18-23 26-43 26-22 0-39-11-39-31 0-15 8-22 15-30 10-12 17-28 36-26Z',
  'M26 17c10-6 18 4 27 3 9 0 17-9 25-2 13 11 14 29 12 47-2 21-16 35-39 35-24 0-40-13-40-35 0-17 2-41 15-48Z',
  'M61 8c8-1 13 4 10 12-4 12 13 17 17 31 6 20-1 39-20 46-19 7-43 1-51-15-9-17-4-40 9-53C35 19 47 10 61 8Z',
  'M46 13c14-5 26 3 28 16 2 12 12 17 16 32 6 23-10 39-35 40-24 1-45-11-45-33 0-14 10-23 15-32 6-10 8-19 21-23Z',
] as const;

export type AgentIdentity = Readonly<{
  palette: number;
  silhouette: number;
  eyes: number;
  smile: number;
  mark: number;
  mirrored: boolean;
  faceTilt: number;
  eyeSpacing: number;
}>;

function hashIdentity(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  // Avalanche the result before selecting traits; nearby IDs should not look related.
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

export function agentIdentity(name: string, id?: string): AgentIdentity {
  // Names only identify unsaved placeholders. Persisted IDs survive renames and routing.
  const key = id?.trim() ? `agent-v1:${id.trim()}` : `draft-v1:${name.trim() || 'Agent'}`;
  const trait = (label: string, count: number) => hashIdentity(`${key}:${label}`) % count;
  return {
    palette: trait('palette', agentPalettes.length),
    silhouette: trait('silhouette', agentSilhouettes.length),
    eyes: trait('eyes', 4),
    smile: trait('smile', 4),
    mark: trait('mark', 8),
    mirrored: trait('mirror', 2) === 1,
    faceTilt: (trait('tilt', 5) - 2) * 3,
    eyeSpacing: 18 + trait('eye-spacing', 4) * 3,
  };
}
