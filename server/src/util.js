// Small shared helpers used by the catalog and the custom-sources modules.
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const YT_RE = /youtube\.com|youtu\.be/i;
const DASH_RE = /\.mpd(\?|$)/i;
const PROGRESSIVE_RE = /\.(mp4|webm|ogg|ogv|mov|m4v|mkv|mp3|aac)(\?|$)/i;
// HLS is frequently served WITHOUT a .m3u8 extension (.php/.htm, path markers,
// or extension-less). Detect it broadly so these streams reach hls.js.
const HLS_RE = /(\.m3u8|m3u8|\/hls\/|\/playlist|chunklist|\/manifest|\/master|\/index\.m3u|\.m3u(\?|$))/i;

export function classifyKind(url) {
  if (!url) return 'other';
  if (YT_RE.test(url)) return 'youtube';
  if (DASH_RE.test(url)) return 'dash';
  if (PROGRESSIVE_RE.test(url)) return 'other';
  if (HLS_RE.test(url)) return 'hls';
  // Extension-less stream URLs on iptv-org are overwhelmingly HLS.
  try {
    const path = new URL(url).pathname;
    const last = path.split('/').pop() || '';
    if (!/\.[a-z0-9]{2,4}$/i.test(last)) return 'hls';
  } catch { /* ignore */ }
  return 'other';
}

// Deterministic id from a stream URL (stable across catalog rebuilds, so
// favorites / deep-links / grid keys survive a refresh). djb2 -> base36.
export function stableId(url) {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// FNV-1a 32-bit -> unsigned int. Cheap, well-spread hash for tie-breaks/rotations
// (NOT used for ids: the id formula above is part of the frozen contract).
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

// Write a file atomically (tmp + rename in the same directory): a crash mid-write
// leaves the previous version intact instead of a truncated file.
export async function writeFileAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
