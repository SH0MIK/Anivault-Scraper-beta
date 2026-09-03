import { fetchJson } from './_shared';
import { cacheGet, cacheSet } from '../utils/cache';

// ══════════════════════════════════════════════════════════════
// SENSHI.LIVE — MAL-ID keyed JSON API (ported from Anivexa's senshi.js)
// ══════════════════════════════════════════════════════════════

const BASE = 'https://senshi.live';
const H = { Referer: `${BASE}/` };

export interface SenshiEpisode {
  num: number;
  id: string; // `${malId}:${num}`
  title: string;
}

export interface SenshiServer {
  name: string;
  sourceId: string; // `hls::<url>` or `embed::<url>`
  type: 'sub' | 'dub';
}

export interface SenshiEmbedResult {
  embedUrl: string;
  m3u8: string | null;
  referer?: string;
}

async function fetchEpisodeList(malId: string): Promise<any[]> {
  const data = await fetchJson<any[]>(`${BASE}/episodes/${malId}`, H);
  return Array.isArray(data) ? data : [];
}

async function fetchEmbeds(malId: string, epNum: number): Promise<any[]> {
  const data = await fetchJson<any[]>(`${BASE}/episode-embeds/${malId}/${epNum}`, H);
  return Array.isArray(data) ? data : [];
}

function isDub(status?: string): boolean {
  return (status ?? '').toLowerCase() === 'dub';
}

export async function getSenshiEpisodes(malId: string): Promise<SenshiEpisode[]> {
  const cacheKey = `senshi:eps:${malId}`;
  const cached = cacheGet<SenshiEpisode[]>(cacheKey);
  if (cached) return cached;

  const items = await fetchEpisodeList(malId);
  const episodes: SenshiEpisode[] = items
    .map((item) => ({
      num: item.ep_id,
      id: `${malId}:${item.ep_id}`,
      title: item.ep_title || `Episode ${item.ep_id}`,
    }))
    .sort((a, b) => a.num - b.num);

  if (episodes.length) cacheSet(cacheKey, episodes, 'episodes');
  return episodes;
}

export async function getSenshiServers(episodeId: string): Promise<SenshiServer[]> {
  const [malId, numStr] = episodeId.split(':');
  const epNum = parseInt(numStr, 10);
  if (!malId || isNaN(epNum)) return [];

  const embeds = await fetchEmbeds(malId, epNum).catch(() => []);
  const servers: SenshiServer[] = [];
  for (const source of embeds) {
    const type: 'sub' | 'dub' = isDub(source.status) ? 'dub' : 'sub';
    if (source.url) servers.push({ name: 'Senshi', sourceId: `hls::${source.url}`, type });
    if (source.server2) servers.push({ name: 'StreamNin', sourceId: `embed::${source.server2}`, type });
    if (source.serverFM) servers.push({ name: 'FileMoon', sourceId: `embed::${source.serverFM}`, type });
  }
  return servers;
}

export async function getSenshiEmbedUrl(sourceId: string): Promise<SenshiEmbedResult | null> {
  const sep = sourceId.indexOf('::');
  if (sep === -1) return null;
  const kind = sourceId.slice(0, sep);
  const url = sourceId.slice(sep + 2);
  if (kind === 'hls') return { embedUrl: url, m3u8: url, referer: `${BASE}/` };
  return { embedUrl: url, m3u8: null, referer: `${BASE}/` };
}
