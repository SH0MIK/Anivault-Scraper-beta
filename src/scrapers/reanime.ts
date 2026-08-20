import axios from 'axios';
import { cacheGet, cacheSet } from '../utils/cache';

// Base URL for the ReAnime FastAPI sidecar (python reanime.py)
// Override via env: REANIME_API_URL=http://localhost:8000
const REANIME_BASE = (process.env.REANIME_API_URL || 'http://localhost:8000').replace(/\/$/, '');

const http = axios.create({
  baseURL: REANIME_BASE,
  timeout: 20000,
  headers: { 'Content-Type': 'application/json' },
});

// ─────────────────────────────────────────────
// Public interfaces (shared shape with other scrapers)
// ─────────────────────────────────────────────

export interface ReAnimeEpisode {
  num: number;
  id: string;   // "{slug}:{epNum}"
  title: string;
}

export interface ReAnimeServer {
  name: string;
  sourceId: string;  // the raw flixcloud dataLink URL
  type: 'sub' | 'dub' | 'raw';
}

export interface ReAnimeEmbedResult {
  embedUrl: string;
  serverName: string;
  type: string;
  referer?: string;
}

export interface ReAnimeStreamResult {
  embedUrl: string;
  streamUrl: string;
  subtitles: { url: string; language: string; format: string; default?: boolean }[];
  thumbnails_vtt: string | null;
  intro_chapter: { start: number; end: number; title: string } | null;
  outro_chapter: { start: number; end: number; title: string } | null;
}

// ─────────────────────────────────────────────
// Search  →  slug
// ─────────────────────────────────────────────

export async function searchReAnime(
  query: string,
  limit = 10,
): Promise<{ slug: string; title: string; cover?: string }[]> {
  const cacheKey = `reanime:search:${query.toLowerCase().trim()}`;
  const cached = cacheGet<any[]>(cacheKey);
  if (cached) return cached;

  const res = await http.get('/search', { params: { q: query, limit } });
  const items: any[] = Array.isArray(res.data) ? res.data : (res.data?.results ?? res.data?.data ?? []);

  const results = items
    .filter((it) => it?.slug || it?.id)
    .map((it) => ({
      slug: it.slug ?? it.id,
      title: it.title?.romaji ?? it.title?.english ?? it.title ?? it.name ?? it.slug,
      cover: it.cover_image?.large ?? it.cover_image?.medium ?? it.image ?? undefined,
    }));

  if (results.length > 0) cacheSet(cacheKey, results, 'episodes');
  return results;
}

// ─────────────────────────────────────────────
// Episodes  (cached 1 h)
// ─────────────────────────────────────────────

export async function getReAnimeEpisodes(slug: string): Promise<ReAnimeEpisode[]> {
  const cacheKey = `reanime:eps:${slug}`;
  const cached = cacheGet<ReAnimeEpisode[]>(cacheKey);
  if (cached) return cached;

  const res = await http.get(`/episodes/${slug}`);
  const raw: any[] = Array.isArray(res.data) ? res.data : (res.data?.episodes ?? []);

  const episodes: ReAnimeEpisode[] = raw
    .map((ep: any) => {
      const num = Number(ep.number ?? ep.num ?? ep.episode_number ?? ep.ep);
      if (!num || num <= 0) return null;
      return {
        num,
        id: `${slug}:${num}`,
        title: ep.title ?? ep.name ?? `Episode ${num}`,
      };
    })
    .filter(Boolean) as ReAnimeEpisode[];

  if (episodes.length > 0) cacheSet(cacheKey, episodes, 'episodes');
  return episodes;
}

// ─────────────────────────────────────────────
// Servers  (returns sub + dub server lists)
// ─────────────────────────────────────────────

export async function getReAnimeServers(episodeId: string): Promise<ReAnimeServer[]> {
  const [slug, numStr] = episodeId.split(':');
  const epNum = parseInt(numStr);
  if (!slug || isNaN(epNum)) return [];

  const cacheKey = `reanime:servers:${slug}:${epNum}`;
  const cached = cacheGet<ReAnimeServer[]>(cacheKey);
  if (cached) return cached;

  const res = await http.get(`/servers/${slug}/${epNum}`);
  const data = res.data;

  const servers: ReAnimeServer[] = [];

  for (const s of (data?.sub ?? [])) {
    if (s?.dataLink) {
      servers.push({
        name: s.serverName ?? 'ReAnime-Sub',
        sourceId: s.dataLink,
        type: 'sub',
      });
    }
  }
  for (const s of (data?.dub ?? [])) {
    if (s?.dataLink) {
      servers.push({
        name: s.serverName ?? 'ReAnime-Dub',
        sourceId: s.dataLink,
        type: 'dub',
      });
    }
  }

  if (servers.length > 0) cacheSet(cacheKey, servers, 'stream');
  return servers;
}

// ─────────────────────────────────────────────
// Embed URL  →  hands the raw flixcloud link back
// to routes.ts so it can pass it to getReAnimeStream()
// ─────────────────────────────────────────────

export async function getReAnimeEmbedUrl(sourceId: string): Promise<ReAnimeEmbedResult | null> {
  if (!sourceId || !/^https?:\/\//i.test(sourceId)) return null;

  // sourceId IS already the flixcloud embed URL — return it directly.
  // The actual decryption happens in getReAnimeStream(), called from watchHandler.
  return {
    embedUrl: sourceId,
    serverName: 'ReAnime',
    type: 'reanime',
  };
}

// ─────────────────────────────────────────────
// Stream  →  decrypts via ReAnime sidecar
// Called by the /watch route after getReAnimeEmbedUrl()
// ─────────────────────────────────────────────

export async function getReAnimeStream(flixcloudUrl: string): Promise<ReAnimeStreamResult | null> {
  try {
    // Tokens are one-time-use; never cache stream responses.
    const res = await http.get('/stream/from-link', {
      params: { link: flixcloudUrl },
    });
    const d = res.data;
    if (!d?.url) return null;

    return {
      embedUrl: flixcloudUrl,
      streamUrl: d.url,
      subtitles: Array.isArray(d.subtitles) ? d.subtitles : [],
      thumbnails_vtt: d.thumbnails_vtt ?? null,
      intro_chapter: d.intro_chapter ?? null,
      outro_chapter: d.outro_chapter ?? null,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Health-check — used by /api/health to report sidecar status
// ─────────────────────────────────────────────

export async function reAnimeHealthCheck(): Promise<{ ok: boolean; url: string }> {
  try {
    await http.get('/', { timeout: 3000 });
    return { ok: true, url: REANIME_BASE };
  } catch {
    return { ok: false, url: REANIME_BASE };
  }
}
