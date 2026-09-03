import axios from 'axios';
import { findBestSlug } from './_shared';
import { cacheGet, cacheSet } from '../utils/cache';

// ══════════════════════════════════════════════════════════════
// KAA (kaa.lt / KickAssAnime) — title-search + JSON API scraper
// (ported from Anivexa's kickassanime.js)
// ══════════════════════════════════════════════════════════════

const BASE = 'https://kaa.lt';
const HLS_BASE = 'https://hls.krussdomi.com/manifest';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Accept: 'application/json' };

export interface KaaEpisode {
  num: number;
  id: string; // `${slug}:${fullEpSlug}`
  title: string;
  hasSub: boolean;
  hasDub: boolean;
}

export interface KaaServer {
  name: string;
  sourceId: string; // resolved HLS manifest url
  type: 'sub' | 'dub';
}

export interface KaaEmbedResult {
  embedUrl: string;
  m3u8: string | null;
  referer?: string;
}

async function kaaSearch(query: string): Promise<any[]> {
  const res = await axios.post(`${BASE}/api/fsearch`, { page: 1, query }, { headers: { ...H, 'Content-Type': 'application/json' }, timeout: 15000 });
  return Array.isArray(res.data?.result) ? res.data.result : [];
}

async function kaaShowInfo(slug: string): Promise<any> {
  const res = await axios.get(`${BASE}/api/show/${slug}`, { headers: H, timeout: 15000 });
  return res.data;
}

async function kaaEpisodePage(slug: string, ep: number): Promise<any> {
  const res = await axios.get(`${BASE}/api/show/${slug}/episodes`, { params: { ep, lang: 'ja-JP' }, headers: H, timeout: 15000 });
  return res.data;
}

async function kaaAllEpisodes(slug: string): Promise<any[]> {
  const first = await kaaEpisodePage(slug, 1);
  const pages = Array.isArray(first.pages) ? first.pages : [];
  const all = Array.isArray(first.result) ? [...first.result] : [];
  if (pages.length > 1) {
    const rest = await Promise.all(
      pages.slice(1).map(async (pg: any) => {
        const startEp = pg.eps?.[0];
        if (!startEp) return [];
        const d = await kaaEpisodePage(slug, startEp);
        return Array.isArray(d.result) ? d.result : [];
      })
    );
    for (const batch of rest) all.push(...batch);
  }
  return all;
}

async function kaaEpisodeServers(slug: string, fullEpSlug: string): Promise<any> {
  const res = await axios.get(`${BASE}/api/show/${slug}/episode/${fullEpSlug}`, { headers: H, timeout: 15000 });
  return res.data;
}

async function search(query: string): Promise<{ slug: string; text: string }[]> {
  const results = await kaaSearch(query);
  return results.map((r: any) => ({ slug: r.slug, text: r.title_en || r.title || r.slug }));
}

export async function findKaaSlug(title: string, altTitle?: string | null): Promise<string | null> {
  // KAA's own results already carry en/native titles for scoring, but our
  // shared findBestSlug/titleScore works fine off `text` alone here too.
  return findBestSlug('kaa:slug', title, altTitle, search);
}

async function buildEpMap(slug: string, showInfo: any): Promise<{ number: number; fullSlug: string; title: string | null }[]> {
  if (showInfo?.type === 'movie') {
    const m = (showInfo.watch_uri || '').match(/\/(ep-(\d+)-([a-f0-9]+))$/i);
    if (m) return [{ number: 1, fullSlug: m[1], title: null }];
    return [];
  }
  const episodes = await kaaAllEpisodes(slug);
  return episodes.map((e: any) => ({ number: e.episode_number, fullSlug: `ep-${e.episode_number}-${e.slug}`, title: e.title }));
}

export async function getKaaEpisodes(slug: string): Promise<KaaEpisode[]> {
  const cacheKey = `kaa:eps:${slug}`;
  const cached = cacheGet<KaaEpisode[]>(cacheKey);
  if (cached) return cached;

  const showInfo = await kaaShowInfo(slug);
  const locales: string[] = Array.isArray(showInfo.locales) ? showInfo.locales : [];
  const hasDub = locales.includes('en-US');
  const epMap = await buildEpMap(slug, showInfo);
  const episodes: KaaEpisode[] = epMap
    .filter((e) => Number.isFinite(e.number) && e.number >= 1)
    .map((e) => ({ num: e.number, id: `${slug}:${e.fullSlug}`, title: e.title || `Episode ${e.number}`, hasSub: true, hasDub }))
    .sort((a, b) => a.num - b.num);

  if (episodes.length) cacheSet(cacheKey, episodes, 'episodes');
  return episodes;
}

export async function getKaaServers(episodeId: string): Promise<KaaServer[]> {
  const [slug, fullSlug] = episodeId.split(':');
  if (!slug || !fullSlug) return [];

  const showInfo = await kaaShowInfo(slug).catch(() => null);
  const locales: string[] = Array.isArray(showInfo?.locales) ? showInfo.locales : [];
  const hasDub = locales.includes('en-US');

  const data = await kaaEpisodeServers(slug, fullSlug).catch(() => null);
  const raw = Array.isArray(data?.servers) ? data.servers : [];

  const servers: KaaServer[] = [];
  for (const s of raw) {
    if (!s.src) continue;
    const m = String(s.src).match(/[?&]id=([^&]+)/);
    if (!m) continue;
    const url = `${HLS_BASE}/${m[1]}/master.m3u8`;
    // KAA's episode-servers endpoint doesn't split by audio track — the same
    // server list backs both sub and dub when the show has an English dub.
    servers.push({ name: s.name || 'KAA', sourceId: url, type: 'sub' });
    if (hasDub) servers.push({ name: s.name || 'KAA', sourceId: url, type: 'dub' });
  }
  return servers;
}

export async function getKaaEmbedUrl(sourceId: string): Promise<KaaEmbedResult | null> {
  if (!/^https?:\/\//i.test(sourceId)) return null;
  return { embedUrl: sourceId, m3u8: sourceId, referer: 'https://krussdomi.com/' };
}
