import { fetchHtml } from './_shared';
import { cacheGet, cacheSet } from '../utils/cache';

// ══════════════════════════════════════════════════════════════
// ANIME-DUNYA.COM — MAL-ID keyed, embedded-JSON HTML scraper
// (ported from Anivexa's animedunya.js — no curl/execSync, no
// FlareSolverr; plain HTTP headers only)
// ══════════════════════════════════════════════════════════════

const BASE = 'https://anime-dunya.com';

export interface AnimedunyaEpisode {
  num: number;
  id: string; // `${malId}:${num}`
  title: string;
}

export interface AnimedunyaServer {
  name: string;
  sourceId: string; // `${malId}:${num}` — resolved lazily in getAnimedunyaEmbedUrl
  type: 'sub';
}

export interface AnimedunyaEmbedResult {
  embedUrl: string;
  m3u8: string | null;
  referer?: string;
  subtitles?: { url: string; label?: string; lang?: string; default?: boolean }[];
}

function extractEpisodesList(html: string): any[] {
  const match = html.match(/\\?"episodes\\?":\s*\[/);
  if (!match || match.index === undefined) return [];
  const idx = match.index;
  const matchLen = match[0].length;
  let braceCount = 1;
  let result = '[';
  for (let i = idx + matchLen; i < html.length; i++) {
    const char = html[i];
    if (char === '[') braceCount++;
    else if (char === ']') braceCount--;
    result += char;
    if (braceCount === 0) break;
  }
  try {
    const cleanStr = result.replace(/\\u0026/g, '&').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return JSON.parse(cleanStr);
  } catch {
    return [];
  }
}

function extractStream(html: string): any | null {
  const match = html.match(/\\?"stream\\?":\s*/);
  if (!match || match.index === undefined) return null;
  const idx = match.index;
  const matchLen = match[0].length;
  let braceCount = 0;
  let started = false;
  let result = '';
  for (let i = idx + matchLen; i < html.length; i++) {
    const char = html[i];
    if (char === '{') {
      braceCount++;
      started = true;
    } else if (char === '}') {
      braceCount--;
    }
    if (started) {
      result += char;
      if (braceCount === 0) break;
    }
  }
  try {
    const cleanStr = result.replace(/\\u0026/g, '&').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return JSON.parse(cleanStr);
  } catch {
    const sourceMatch = html.match(/"source"\s*:\s*"([^"]+)"/);
    if (sourceMatch) return { source: sourceMatch[1].replace(/\\/g, '') };
    return null;
  }
}

export async function getAnimedunyaEpisodes(malId: string): Promise<AnimedunyaEpisode[]> {
  const cacheKey = `animedunya:eps:${malId}`;
  const cached = cacheGet<AnimedunyaEpisode[]>(cacheKey);
  if (cached) return cached;

  const html = await fetchHtml(`${BASE}/en/anime/${malId}`);
  const raw = extractEpisodesList(html);
  const watchable = raw.filter((ep) => ep.streamId !== null && ep.streamId !== undefined);

  const episodes: AnimedunyaEpisode[] = watchable
    .map((ep) => {
      const num = ep.episodeNumber;
      const customTitle = Array.isArray(ep.translations)
        ? ep.translations.find((t: any) => t.language === 'en')?.title
        : ep.translations?.title;
      return { num, id: `${malId}:${num}`, title: customTitle || `Episode ${num}` };
    })
    .sort((a, b) => a.num - b.num);

  if (episodes.length) cacheSet(cacheKey, episodes, 'episodes');
  return episodes;
}

export async function getAnimedunyaServers(episodeId: string): Promise<AnimedunyaServer[]> {
  const [malId, numStr] = episodeId.split(':');
  if (!malId || !numStr) return [];
  return [{ name: 'AnimeDunya', sourceId: episodeId, type: 'sub' }];
}

export async function getAnimedunyaEmbedUrl(sourceId: string): Promise<AnimedunyaEmbedResult | null> {
  const [malId, numStr] = sourceId.split(':');
  if (!malId || !numStr) return null;
  try {
    const html = await fetchHtml(`${BASE}/en/play/${malId}/${numStr}`);
    const streamData = extractStream(html);
    if (!streamData?.source) return null;
    const subtitles = (streamData.subtitles || []).map((s: any) => ({
      url: s.src,
      label: s.label,
      lang: s.srclang,
      default: s.default || false,
    }));
    return { embedUrl: streamData.source, m3u8: streamData.source, referer: `${BASE}/`, subtitles };
  } catch {
    return null;
  }
}
