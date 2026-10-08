// Merge several XMLTV part files into one guide (dedup channels by id).
// Usage: node merge.mjs <partsDir> <outFile>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, out] = process.argv.slice(2);
if (!dir || !out) { console.error('usage: merge.mjs <dir> <out>'); process.exit(1); }

const files = readdirSync(dir).filter((f) => f.endsWith('.xml'));
const channels = new Map();
const programmes = [];

for (const f of files) {
  let xml = '';
  try { xml = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
  for (const m of xml.matchAll(/<channel\b[\s\S]*?<\/channel>/g)) {
    const id = (m[0].match(/id="([^"]+)"/) || [])[1];
    if (id && !channels.has(id)) channels.set(id, m[0]);
  }
  for (const m of xml.matchAll(/<programme\b[\s\S]*?<\/programme>/g)) programmes.push(m[0]);
}

const body = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<tv generator-info-name="neowatch-epg">',
  ...channels.values(),
  ...programmes,
  '</tv>',
].join('\n');

writeFileSync(out, body);
console.error(`merged ${channels.size} channels, ${programmes.length} programmes -> ${out}`);
