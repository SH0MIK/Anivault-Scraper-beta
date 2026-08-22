import axios from 'axios';
import { cacheGet, cacheSet } from '../utils/cache';

// ══════════════════════════════════════════════════════════════
// KITSU — official JSON:API, not a scrape (same as anilist.ts / tmdb.ts).
//
// Ported from the site's src/lib/episode-thumb.ts "Source 1: Kitsu" block.
// Unlike TMDB, Kitsu mirrors MAL's per-season split -- Season 2 of an anime
// has its own distinct Kitsu anime ID, mapped directly from the Season 2
// MAL ID. So there's no season-stripping/hinting needed here the way TMDB
// required; a MAL ID (whichever season) maps straight to the right Kitsu
// anime ID via the mappings endpoint, falling back to a plain title search
// only when that mapping doesn't exist yet.
// ══════════════════════════════════════════════════════════════

const kitsuClient = axios.create({
  baseURL: 'https://kitsu.app/api/edge',
  timeout: 10000,
  headers: { Accept: 'application/vnd.api+json' },
});

export interface KitsuEpisodeThumb {
  kitsuAnimeId: number;
  episodeId: number;
  size: string;   // which thumbnail size was used: original/large/medium/small/tiny
  thumbnail: string;
}

export interface KitsuEpisodeThumbResult {
  result: KitsuEpisodeThumb | null;
  kitsuAnimeId: number | null;
  log: string[];
}

/**
 * Resolves a MAL ID (and/or title) to a Kitsu anime ID: MAL mapping first,
 * title search as fallback -- exactly the two steps episode-thumb.ts used.
 * Cached under the long-lived 'mapping' bucket since this pairing never
 * changes for a given MAL ID/title.
 */
export async function getKitsuAnimeId(
  malId: number | null,
  animeTitle: string | null,
  log: string[]
): Promise<number | null> {
  const cacheKey = malId ? `kitsu:id:mal:${malId}` : `kitsu:id:title:${(animeTitle ?? '').toLowerCase()}`;
  const cached = cacheGet<number | null>(cacheKey);
  if (cached !== null) {
    log.push('Kitsu ID lookup: cache hit');
    return cached;
  }

  let kitsuAnimeId: number | null = null;

  if (malId) {
    try {
      const mapRes = await kitsuClient.get('/mappings', {
        params: { 'filter[externalSite]': 'myanimelist/anime', 'filter[externalId]': malId, include: 'item' },
      });
      for (const item of mapRes.data?.included ?? []) {
        if (item.type === 'anime') { kitsuAnimeId = parseInt(item.id, 10); break; }
      }
      log.push(`Kitsu mapping: ${kitsuAnimeId ? `found ID ${kitsuAnimeId}` : 'not found'}`);
    } catch (e: any) {
      log.push(`Kitsu mapping: request failed (${e?.response?.status ?? e?.message})`);
    }
  }

  if (!kitsuAnimeId && animeTitle) {
    try {
      const srchRes = await kitsuClient.get('/anime', {
        params: { 'filter[text]': animeTitle, 'page[limit]': 3 },
      });
      const first = srchRes.data?.data?.[0]?.id;
      kitsuAnimeId = first ? parseInt(first, 10) : null;
      log.push(`Kitsu title search: ${kitsuAnimeId ? `found ID ${kitsuAnimeId}` : 'not found'}`);
    } catch (e: any) {
      log.push(`Kitsu title search: request failed (${e?.response?.status ?? e?.message})`);
    }
  }

  cacheSet(cacheKey, kitsuAnimeId, 'mapping');
  return kitsuAnimeId;
}

/**
 * Episode-specific thumbnail for a known Kitsu anime ID + episode number.
 * Tries thumbnail sizes largest-first, same order episode-thumb.ts used.
 */
export async function getEpisodeThumbnail(
  kitsuAnimeId: number,
  epNum: number,
  isList = false
): Promise<KitsuEpisodeThumbResult> {
  const log: string[] = [];
  const cacheKey = `kitsu:epthumb:${kitsuAnimeId}:${epNum}`;

  if (!isList) {
    const cached = cacheGet<KitsuEpisodeThumb | null>(cacheKey);
    if (cached !== null) {
      log.push('Kitsu ep thumbnail: cache hit');
      return { result: cached, kitsuAnimeId, log };
    }
  }

  try {
    const epRes = await kitsuClient.get(`/anime/${kitsuAnimeId}/episodes`, {
      params: { 'filter[number]': epNum, 'page[limit]': 1 },
    });
    const epData = epRes.data?.data?.[0] ?? null;

    if (!epData) {
      log.push(`Kitsu ep ${epNum}: episode record not found`);
      cacheSet(cacheKey, null, 'episodes');
      return { result: null, kitsuAnimeId, log };
    }

    const imgs = epData.attributes?.thumbnail ?? {};
    log.push(`Kitsu ep ${epNum} thumbnail: ${Object.keys(imgs).length === 0 ? 'empty (no image on Kitsu)' : JSON.stringify(imgs)}`);

    for (const size of ['original', 'large', 'medium', 'small', 'tiny']) {
      if (imgs[size]) {
        const result: KitsuEpisodeThumb = {
          kitsuAnimeId,
          episodeId: parseInt(epData.id, 10),
          size,
          thumbnail: imgs[size],
        };
        cacheSet(cacheKey, result, 'episodes');
        return { result, kitsuAnimeId, log };
      }
    }

    log.push(`Kitsu ep ${epNum}: no image on Kitsu`);
    cacheSet(cacheKey, null, 'episodes');
    return { result: null, kitsuAnimeId, log };
  } catch (e: any) {
    const status = e?.response?.status;
    log.push(`Kitsu ep: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
    return { result: null, kitsuAnimeId, log };
  }
}
