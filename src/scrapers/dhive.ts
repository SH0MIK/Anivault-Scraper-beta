import { fetchHtml } from './_shared';
import { cacheGet, cacheSet } from '../utils/cache';

// ══════════════════════════════════════════════════════════════
// 2DHIVE.COM — MAL-ID keyed scraper (ported from Anivexa's 2dhive.js)
//
// NOTE: 2dhive's own player serves its HLS playlist as inline text embedded
// in the episode page's Astro props (not a fetchable URL) — the original
// Anivexa route re-exposes that text through its own `/stream/...` endpoint.
// Reproducing that here would mean adding a new raw-passthrough route, out
// of scope for this pass — so this scraper surfaces the MegaPlay iframe
// mirror instead, which 2dhive itself falls back to and is a normal
// fetchable embed URL.
// ══════════════════════════════════════════════════════════════

const BASE = 'https://2dhive.com';

export interface DhiveEpisode {
  num: number;
  id: string; // `${malId}:${num}`
  title: string;
  hasDub: boolean;
}

export interface DhiveServer {
  name: string;
  sourceId: string; // MegaPlay embed url
  type: 'sub' | 'dub';
}

export interface DhiveEmbedResult {
  embedUrl: string;
  m3u8: string | null;
  referer?: string;
}

function extractPlayerProps(html: string): any {
  const idx = html.indexOf('prefetchedHls');
  if (idx === -1) return null;
  const propsIdx = html.lastIndexOf('props="', idx);
  if (propsIdx === -1) return null;
  const valueIdx = propsIdx + 7;
  const endIdx = html.indexOf('"', valueIdx);
  if (endIdx === -1) return null;
  const raw = html
    .slice(valueIdx, endIdx)
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function astroDecode(v: any): any {
  if (!Array.isArray(v)) return v;
  const [type, data] = v;
  if (type === 0) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return data;
    return Object.fromEntries(Object.entries(data).map(([k, val]) => [k, astroDecode(val)]));
  }
  if (type === 1) return Array.isArray(data) ? data.map(astroDecode) : data;
  return data;
}

function decodeProps(raw: any): any {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, astroDecode(v)]));
}

function parseEpisodeNums(html: string, malId: string): number[] {
  const re = new RegExp(`/episode\\?anime=${malId}&(?:amp;)?ep_num=(\\d+)`, 'gi');
  const nums = new Set<number>();
  for (const m of html.matchAll(re)) nums.add(Number(m[1]));
  return [...nums].sort((a, b) => a - b);
}

async function fetchEpisodeProps(malId: string, epNum: number): Promise<any> {
  const cacheKey = `dhive:props:${malId}:${epNum}`;
  const cached = cacheGet<any>(cacheKey);
  if (cached) return cached;
  const html = await fetchHtml(`${BASE}/episode?anime=${malId}&ep_num=${epNum}`);
  const rawProps = extractPlayerProps(html);
  if (!rawProps) return null;
  const props = decodeProps(rawProps);
  cacheSet(cacheKey, props, 'stream');
  return props;
}

export async function getDhiveEpisodes(malId: string): Promise<DhiveEpisode[]> {
  const cacheKey = `dhive:eps:${malId}`;
  const cached = cacheGet<DhiveEpisode[]>(cacheKey);
  if (cached) return cached;

  const animeHtml = await fetchHtml(`${BASE}/anime?anime=${malId}`);
  const epNums = parseEpisodeNums(animeHtml, malId);
  if (!epNums.length) return [];

  const props = await fetchEpisodeProps(malId, epNums[0]).catch(() => null);
  const hasDub = Boolean(props?.prefetchedHls?.dub?.content);
  const episodes: DhiveEpisode[] = epNums.map((num) => ({ num, id: `${malId}:${num}`, title: `Episode ${num}`, hasDub }));
  cacheSet(cacheKey, episodes, 'episodes');
  return episodes;
}

export async function getDhiveServers(episodeId: string): Promise<DhiveServer[]> {
  const [malId, numStr] = episodeId.split(':');
  const epNum = parseInt(numStr, 10);
  if (!malId || isNaN(epNum)) return [];

  const servers: DhiveServer[] = [{ name: 'MegaPlay', sourceId: `https://megaplay.buzz/stream/mal/${malId}/${epNum}/sub`, type: 'sub' }];
  const props = await fetchEpisodeProps(malId, epNum).catch(() => null);
  if (props?.prefetchedHls?.dub?.content) {
    servers.push({ name: 'MegaPlay', sourceId: `https://megaplay.buzz/stream/mal/${malId}/${epNum}/dub`, type: 'dub' });
  }
  return servers;
}

export async function getDhiveEmbedUrl(sourceId: string): Promise<DhiveEmbedResult | null> {
  if (!/^https?:\/\//i.test(sourceId)) return null;
  return { embedUrl: sourceId, m3u8: null, referer: `${BASE}/` };
}
