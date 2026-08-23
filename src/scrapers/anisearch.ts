import { makeClient } from '../utils/fetch';
import { cacheGet, cacheSet } from '../utils/cache';

// ══════════════════════════════════════════════════════════════
// ANISEARCH — actual HTML scrape (unlike anilist.ts/tmdb.ts/kitsu.ts, which
// hit official APIs). AniSearch has no public API, so this ports the site's
// exact regex-based extraction from episode-thumb.ts "Source 5":
//   1. text-search their site, regex the anime ID out of the results HTML
//   2. load the episode page, regex the og:image meta tag out
//
// AniSearch hasn't shown Cloudflare-challenge behavior on these two GET
// endpoints so far (unlike Senshi, which needs FlareSolverr) -- if that
// changes, flip `useFlareSolverr` to `true` in the makeClient() call below,
// same way senshi.ts does.
// ══════════════════════════════════════════════════════════════

const BASE = 'https://www.anisearch.com';
const http = makeClient(BASE, BASE + '/');

export interface AniSearchEpisodeThumb {
  aniSearchId: number;
  thumbnail: string;
}

export interface AniSearchEpisodeThumbResult {
  result: AniSearchEpisodeThumb | null;
  aniSearchId: number | null;
  log: string[];
}

/**
 * Resolves an anime title to an AniSearch anime ID via their text search.
 * AniSearch has no MAL-mapping endpoint (unlike Kitsu), so this is
 * title-search only. Cached under the long-lived 'mapping' bucket.
 */
export async function getAniSearchId(animeTitle: string, log: string[]): Promise<number | null> {
  const cacheKey = `anisearch:id:${animeTitle.toLowerCase()}`;
  const cached = cacheGet<number | null>(cacheKey);
  if (cached !== null) {
    log.push('AniSearch ID lookup: cache hit');
    return cached;
  }

  let aniSearchId: number | null = null;
  try {
    const res = await http.get('/anime/index/', { params: { q: animeTitle, mode: 2, per: 1 } });
    const body: string = res.data ?? '';
    const idMatch = body.match(/\/anime\/(\d+)[,/]/);
    aniSearchId = idMatch ? parseInt(idMatch[1], 10) : null;
    log.push(`AniSearch: ${aniSearchId ? `found anime ID ${aniSearchId}` : 'anime not found'}`);
  } catch (e: any) {
    const status = e?.response?.status;
    log.push(`AniSearch search: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
  }

  cacheSet(cacheKey, aniSearchId, 'mapping');
  return aniSearchId;
}

/**
 * Episode-specific still for a known AniSearch anime ID + episode number.
 * Scrapes the og:image meta tag off the episode page, same as the site did.
 */
export async function getEpisodeThumbnail(
  aniSearchId: number,
  epNum: number,
  isList = false
): Promise<AniSearchEpisodeThumbResult> {
  const log: string[] = [];
  const cacheKey = `anisearch:epthumb:${aniSearchId}:${epNum}`;

  if (!isList) {
    const cached = cacheGet<AniSearchEpisodeThumb | null>(cacheKey);
    if (cached !== null) {
      log.push('AniSearch ep thumbnail: cache hit');
      return { result: cached, aniSearchId, log };
    }
  }

  try {
    const res = await http.get(`/anime/${aniSearchId}/episodes/${epNum}`);
    const body: string = res.data ?? '';
    const ogMatch = body.match(/<meta property="og:image" content="([^"]+)"/);

    if (!ogMatch) {
      log.push(`AniSearch ep ${epNum}: no image found`);
      cacheSet(cacheKey, null, 'episodes');
      return { result: null, aniSearchId, log };
    }

    const thumbnail = ogMatch[1]
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'");

    const result: AniSearchEpisodeThumb = { aniSearchId, thumbnail };
    log.push(`AniSearch ep ${epNum}: found ${thumbnail}`);
    cacheSet(cacheKey, result, 'episodes');
    return { result, aniSearchId, log };
  } catch (e: any) {
    const status = e?.response?.status;
    log.push(`AniSearch ep: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
    return { result: null, aniSearchId, log };
  }
}
