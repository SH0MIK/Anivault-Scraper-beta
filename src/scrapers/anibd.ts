import { fetchHtml, fetchJson } from './_shared';
import { cacheGet, cacheSet } from '../utils/cache';

// ══════════════════════════════════════════════════════════════
// ANIBD (epeng.animeapps.top) — AniList-ID keyed JSON API
// (ported from Anivexa's anibd.js)
// ══════════════════════════════════════════════════════════════

const BASE = 'https://epeng.animeapps.top';

export interface AnibdEpisode {
  num: number;
  id: string; // `${anilistId}:${audio}:${num}`
  title: string;
}

export interface AnibdServer {
  name: string;
  sourceId: string; // `hls::<url>::<referer>` or `embed::<url>`
  type: 'sub' | 'dub';
}

export interface AnibdEmbedResult {
  embedUrl: string;
  m3u8: string | null;
  referer?: string;
}

async function fetchServers(anilistId: string): Promise<any[]> {
  const data = await fetchJson<any[]>(`${BASE}/api2.php?epid=${anilistId}`);
  return Array.isArray(data) ? data : [];
}

async function fetchPlayerLinks(providerLink: string): Promise<any[]> {
  const data = await fetchJson<any[]>(`${BASE}/apilink.php?data=${encodeURIComponent(providerLink)}`);
  return Array.isArray(data) ? data : [];
}

function audioFromServerName(name = ''): 'sub' | 'dub' {
  return /dub/i.test(name) ? 'dub' : 'sub';
}

export async function getAnibdEpisodes(anilistId: string): Promise<AnibdEpisode[]> {
  const cacheKey = `anibd:eps:${anilistId}`;
  const cached = cacheGet<AnibdEpisode[]>(cacheKey);
  if (cached) return cached;

  const groups = await fetchServers(anilistId);
  const episodes: AnibdEpisode[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    const audio = audioFromServerName(group.server_name);
    for (const ep of group.server_data ?? []) {
      const num = Number(ep.name ?? ep.slug);
      if (!Number.isFinite(num) || num < 1) continue;
      const key = `${audio}:${num}`;
      if (seen.has(key)) continue;
      seen.add(key);
      episodes.push({ num, id: `${anilistId}:${audio}:${num}`, title: `Episode ${num}` });
    }
  }
  episodes.sort((a, b) => a.num - b.num);
  if (episodes.length) cacheSet(cacheKey, episodes, 'episodes');
  return episodes;
}

function extractVideoUrl(html: string, origin: string): string | null {
  const m = html.match(/videoUrl\s*:\s*"([^"]+)"/);
  if (!m) return null;
  const raw = m[1];
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${origin}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

async function resolvePlayerStream(playerLink: string): Promise<{ hls: string; referer: string } | null> {
  try {
    const origin = new URL(playerLink).origin;
    const referer = `${origin}/`;
    const html = await fetchHtml(playerLink, { Referer: referer });
    const hls = extractVideoUrl(html, origin);
    return hls ? { hls, referer } : null;
  } catch {
    return null;
  }
}

export async function getAnibdServers(episodeId: string): Promise<AnibdServer[]> {
  const [anilistId, audio, numStr] = episodeId.split(':');
  const num = parseInt(numStr, 10);
  if (!anilistId || !audio || isNaN(num)) return [];

  const groups = await fetchServers(anilistId);
  let providerLink: string | null = null;
  for (const group of groups) {
    if (audioFromServerName(group.server_name) !== audio) continue;
    for (const ep of group.server_data ?? []) {
      if (Number(ep.name ?? ep.slug) === num) providerLink = ep.link;
    }
  }
  if (!providerLink) return [];

  const links = await fetchPlayerLinks(providerLink).catch(() => []);
  const servers: AnibdServer[] = [];
  for (const entry of links) {
    if (!entry?.link) continue;
    const resolved = await resolvePlayerStream(entry.link);
    if (resolved) {
      servers.push({ name: entry.server ?? 'AniBD', sourceId: `hls::${resolved.hls}::${resolved.referer}`, type: audio as 'sub' | 'dub' });
    } else {
      servers.push({ name: entry.server ?? 'AniBD', sourceId: `embed::${entry.link}`, type: audio as 'sub' | 'dub' });
    }
  }
  return servers;
}

export async function getAnibdEmbedUrl(sourceId: string): Promise<AnibdEmbedResult | null> {
  if (sourceId.startsWith('hls::')) {
    const [, url, referer] = sourceId.split('::');
    return { embedUrl: url, m3u8: url, referer };
  }
  if (sourceId.startsWith('embed::')) {
    const url = sourceId.slice('embed::'.length);
    return { embedUrl: url, m3u8: null, referer: `${new URL(url).origin}/` };
  }
  return null;
}
