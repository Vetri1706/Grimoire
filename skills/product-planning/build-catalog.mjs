// Maintainer utility: bundles local, reviewed instruction text only. No network or execution of skills.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const catalogPath = path.resolve(directory, '../../web/src/skillCatalog.ts');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const text = bytes => bytes.toString('utf8').replace(/\r\n/g, '\n');

function withinDirectory(relativePath) {
  const absolute = path.resolve(directory, relativePath);
  if (!absolute.startsWith(`${directory}${path.sep}`)) throw new Error('Skill path must stay inside its bundle.');
  return absolute;
}

export async function productPlanningCatalog() {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.formatVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(manifest.adaptationVersion)) throw new Error('Unsupported skill manifest.');
  const license = await readFile(withinDirectory(manifest.licensePath));
  if (digest(license) !== manifest.licenseSha256) throw new Error('Upstream license digest changed.');
  const ids = new Set();
  const skills = [];
  for (const entry of manifest.skills) {
    if (!/^grimoire-[a-z0-9-]+$/.test(entry.id) || ids.has(entry.id)) throw new Error('Invalid or duplicate starter skill ID.');
    ids.add(entry.id);
    if (!/^[a-f0-9]{40}$/.test(entry.source.commit) || !/^[a-f0-9]{64}$/.test(entry.source.sha256)) throw new Error('Skill source must be immutable.');
    const original = await readFile(withinDirectory(entry.upstreamPath));
    if (digest(original) !== entry.source.sha256) throw new Error(`Upstream source digest changed: ${entry.id}`);
    const instructions = text(await readFile(withinDirectory(`${entry.id}/SKILL.md`))).trimEnd() + '\n';
    const frontmatter = instructions.match(/^---\nname: ([a-z0-9-]+)\ndescription: ([^\n]+)\n---\n/);
    if (!frontmatter || frontmatter[1] !== entry.id) throw new Error(`Skill frontmatter disagrees with manifest: ${entry.id}`);
    const description = frontmatter[2];
    if (!entry.name?.trim() || Buffer.byteLength(entry.name) > 100 || Buffer.byteLength(description) > 2000 || Buffer.byteLength(instructions) > 12000 || instructions.includes('\0')) throw new Error(`Skill exceeds native API bounds: ${entry.id}`);
    for (const value of [entry.source.catalogUrl, entry.source.repository, entry.source.commit, entry.source.path, entry.source.sha256, `License: ${entry.source.license}`, `Grimoire adaptation version: ${manifest.adaptationVersion}`, text(license).trim()]) {
      if (!instructions.includes(value)) throw new Error(`Persisted skill loses provenance or license: ${entry.id}`);
    }
    skills.push({ id: entry.id, name: entry.name, description, instructions, source: entry.source, adaptationVersion: manifest.adaptationVersion });
  }
  return skills;
}

export function renderCatalog(skills) {
  return `// Generated from skills/product-planning by build-catalog.mjs. Edit the SKILL.md files and manifest, then regenerate.\n// Contains reviewed text only; importing this catalog performs no network requests or installation.\nexport type StarterSkillSource = {\n  catalogUrl: string; repository: string; commit: string; path: string; sha256: string; license: string;\n};\n\nexport type StarterSkill = {\n  id: string; name: string; description: string; instructions: string; source: StarterSkillSource; adaptationVersion: string;\n};\n\nexport const starterSkills: readonly StarterSkill[] = ${JSON.stringify(skills, null, 2)};\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = renderCatalog(await productPlanningCatalog());
  if (process.argv.includes('--check')) {
    const actual = text(await readFile(catalogPath));
    if (actual !== output) throw new Error('Web skill catalog is stale. Run node skills/product-planning/build-catalog.mjs.');
    console.log('Product-planning catalog matches reviewed skills and upstream digests.');
  } else {
    await writeFile(catalogPath, output, 'utf8');
    console.log('Generated web/src/skillCatalog.ts from reviewed product-planning skills.');
  }
}
