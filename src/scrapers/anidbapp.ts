import { attr, decodeEntities, fetchHtml, fetchJson, findBestSlug, stripTags } from './_shared';
import { cacheGet, cacheSet } from '../utils/cache';

// ══════════════════════════════════════════════════════════════
// ANIDB.APP — title-search + per-language embed scraper
// (ported from Anivexa's anidbapp.js — the original used a curl shell-out
// for header-order Cloudflare evasion; that's dropped here in favor of
// plain axios headers, per no-FlareSolverr / no-shell-tricks constraint.
// This means anidb.app's CF challenge may block requests intermittently.)
// ══════════════════════════════════════════════════════════════

const BASE = 'https://anidb.app';

export interface AnidbappEpisode {
  num: number;
  id: string; // `${slug}:${siteId}:${providerEpisodeId}`
  title: string;
}

export interface AnidbappServer {
  name: string;
  sourceId: string; // embed url
  type: 'sub' | 'dub';
}

export interface AnidbappEmbedResult {
  embedUrl: string;
  m3u8: string | null;
  referer?: string;
}

async function search(query: string): Promise<{ slug: string; text: string }[]> {
  const html = await fetchHtml(`${BASE}/search/suggestions?q=${encodeURIComponent(query)}`, {
    Accept: 'application/json, text/html, */*;q=0.8',
    Referer: `${BASE}/home`,
    'X-Requested-With': 'XMLHttpRequest',
  }).catch(() => '');
  const results: { slug: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*data-search-item\b[^>]*>[\s\S]*?<\/a>/gi)) {
    const tag = m[0].match(/<a\b[^>]*>/i)?.[0] ?? '';
    const href = attr(tag, 'href');
    const path = href.startsWith('http') ? new URL(href).pathname : href;
    const slug = path.match(/^\/anime\/([^/?#]+)/)?.[1];
    if (!slug) continue;
    const title = stripTags(m[0].match(/<p\b[^>]*class=["'][^"']*text-sm[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '');
    results.push({ slug, text: title || slug.replace(/-/g, ' ') });
  }
  return results;
}

export async function findAnidbappSlug(title: string, altTitle?: string | null): Promise<string | null> {
  return findBestSlug('anidbapp:slug', title, altTitle, search);
}

function siteIdFromSlug(slug: string): number | null {
  const m = slug.match(/-(\d+)$/);
  return m ? Number(m[1]) : null;
}

async function fetchProviderEpisodes(siteId: number): Promise<any[]> {
  const cacheKey = `anidbapp:eps:${siteId}`;
  const cached = cacheGet<any[]>(cacheKey);
  if (cached) return cached;

  const data = await fetchJson<any>(`${BASE}/api/frontend/anime/${siteId}/episodes`, {
    Accept: 'application/json',
    Referer: `${BASE}/anime/${siteId}`,
    'X-Requested-With': 'XMLHttpRequest',
  });
  const episodes = Array.isArray(data.episodes) ? data.episodes : [];
  if (episodes.length) cacheSet(cacheKey, episodes, 'episodes');
  return episodes;
}

export async function getAnidbappEpisodes(slug: string): Promise<AnidbappEpisode[]> {
  const siteId = siteIdFromSlug(slug);
  if (!siteId) return [];
  const raw = await fetchProviderEpisodes(siteId);
  return raw
    .map((ep: any) => ({
      num: Number(ep.number),
      id: `${slug}:${siteId}:${ep.id}`,
      title: `Episode ${ep.number}`,
    }))
    .filter((ep) => Number.isFinite(ep.num))
    .sort((a, b) => a.num - b.num);
}

function languageForAudio(languages: any[], audio: 'sub' | 'dub') {
  const preferred = audio === 'sub' ? ['jpn', 'ja', 'japanese'] : ['eng', 'en', 'english'];
  return (
    languages.find((l) => preferred.includes(String(l.code ?? '').toLowerCase())) ??
    languages.find((l) => preferred.includes(String(l.name ?? '').toLowerCase())) ??
    null
  );
}

async function fetchLanguages(episodeId: string, seriesSlug: string): Promise<any[]> {
  const data = await fetchJson<any>(`${BASE}/api/frontend/episode/${episodeId}/languages`, {
    Accept: 'application/json',
    Referer: `${BASE}/anime/${seriesSlug}`,
    'X-Requested-With': 'XMLHttpRequest',
  }).catch(() => null);
  return Array.isArray(data?.languages) ? data.languages : [];
}

export async function getAnidbappServers(episodeId: string): Promise<AnidbappServer[]> {
  const [slug, , providerEpisodeId] = episodeId.split(':');
  if (!slug || !providerEpisodeId) return [];

  const languages = await fetchLanguages(providerEpisodeId, slug);
  const servers: AnidbappServer[] = [];
  for (const audio of ['sub', 'dub'] as const) {
    const lang = languageForAudio(languages, audio);
    if (lang?.embed_url) {
      servers.push({ name: `AniDB.app (${lang.code ?? audio})`, sourceId: decodeEntities(lang.embed_url), type: audio });
    }
  }
  return servers;
}

function extractHls(html: string): string | null {
  const patterns = [
    /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    /sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\/master\.m3u8[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
  ];
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m?.[1]) return decodeEntities(m[1]);
  }
  return null;
}

export async function getAnidbappEmbedUrl(sourceId: string): Promise<AnidbappEmbedResult | null> {
  try {
    const html = await fetchHtml(sourceId, { Referer: `${BASE}/` });
    const hls = extractHls(html);
    return { embedUrl: sourceId, m3u8: hls, referer: `${new URL(sourceId).origin}/` };
  } catch {
    return { embedUrl: sourceId, m3u8: null, referer: `${BASE}/` };
  }
}
