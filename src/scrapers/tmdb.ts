import axios from 'axios';
import { cacheGet, cacheSet } from '../utils/cache';

// ══════════════════════════════════════════════════════════════
// TMDB — official REST API, not a scrape (same as anilist.ts).
//
// Ported from the site's src/lib/episode-thumb.ts "Source 2: TMDB" block so
// the Cloudflare Worker no longer has to call api.themoviedb.org itself.
// Same lookup: search the show by title, then check season 1 and 2 for the
// requested episode number, same as before.
// ══════════════════════════════════════════════════════════════

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

const tmdbClient = axios.create({
  baseURL: 'https://api.themoviedb.org/3',
  timeout: 10000,
});

export interface TmdbEpisodeThumb {
  showId: number;
  showName: string;
  season: number;
  stillPath: string;
  thumbnail: string;        // w780 — matches what episode-thumb.ts used for og:image / Continue Watching
  thumbnailOriginal: string; // full-res, only useful for the admin "list all candidates" view
}

export interface TmdbEpisodeThumbResult {
  result: TmdbEpisodeThumb | null;
  log: string[];
}

export interface TmdbAnimeImages {
  showId: number;
  showName: string;
  poster: string | null;          // w500 — anime "cover" image
  posterOriginal: string | null;
  backdrop: string | null;        // w1280 — banner
  backdropOriginal: string | null;
  logo: string | null;            // w500 — transparent title logo
  logoOriginal: string | null;
}

export interface TmdbAnimeImagesResult {
  result: TmdbAnimeImages | null;
  log: string[];
}

// Prefer English art, then language-neutral (usually vector/textless), then
// just whatever scored highest — same idea TMDB's own web UI uses.
function pickBestImage(arr: any[]): any | null {
  if (!arr || arr.length === 0) return null;
  const byVotes = [...arr].sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0));
  return byVotes.find((i) => i.iso_639_1 === 'en') || byVotes.find((i) => !i.iso_639_1) || byVotes[0];
}

/**
 * Poster (cover), backdrop (banner), and logo for a show, by title.
 * One search + one /images call, cached under the long-lived 'mapping'
 * bucket since a show's art doesn't change often.
 */
export async function getAnimeImages(
  animeTitle: string,
  isList = false
): Promise<TmdbAnimeImagesResult> {
  const log: string[] = [];

  if (!TMDB_API_KEY) {
    log.push('TMDB: skipped (no TMDB_API_KEY set on scraper)');
    return { result: null, log };
  }

  const cacheKey = `tmdb:images:${animeTitle.toLowerCase()}`;
  if (!isList) {
    const cached = cacheGet<TmdbAnimeImages | null>(cacheKey);
    if (cached !== null) {
      log.push('TMDB: cache hit');
      return { result: cached, log };
    }
  }

  try {
    const srch = await tmdbClient.get('/search/tv', {
      params: { api_key: TMDB_API_KEY, query: animeTitle, language: 'en-US' },
    });
    const results = srch.data?.results ?? [];

    if (results.length === 0) {
      log.push(`TMDB: no show found for '${animeTitle}'`);
      cacheSet(cacheKey, null, 'mapping');
      return { result: null, log };
    }

    const show = results[0];
    const showId = show.id;
    log.push(`TMDB: matched '${show.name}' (ID ${showId})`);

    const imgRes = await tmdbClient.get(`/tv/${showId}/images`, {
      params: { api_key: TMDB_API_KEY, include_image_language: 'en,ja,null' },
    });

    const posters: any[] = imgRes.data?.posters ?? [];
    const backdrops: any[] = imgRes.data?.backdrops ?? [];
    const logos: any[] = imgRes.data?.logos ?? [];
    log.push(`TMDB images: ${posters.length} posters, ${backdrops.length} backdrops, ${logos.length} logos`);

    const poster = pickBestImage(posters);
    const backdrop = pickBestImage(backdrops);
    const logo = pickBestImage(logos);

    const result: TmdbAnimeImages = {
      showId,
      showName: show.name,
      poster: poster ? `https://image.tmdb.org/t/p/w500${poster.file_path}` : null,
      posterOriginal: poster ? `https://image.tmdb.org/t/p/original${poster.file_path}` : null,
      backdrop: backdrop ? `https://image.tmdb.org/t/p/w1280${backdrop.file_path}` : null,
      backdropOriginal: backdrop ? `https://image.tmdb.org/t/p/original${backdrop.file_path}` : null,
      logo: logo ? `https://image.tmdb.org/t/p/w500${logo.file_path}` : null,
      logoOriginal: logo ? `https://image.tmdb.org/t/p/original${logo.file_path}` : null,
    };

    cacheSet(cacheKey, result, 'mapping');
    return { result, log };
  } catch (e: any) {
    const status = e?.response?.status;
    log.push(`TMDB images: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
    return { result: null, log };
  }
}

/**
 * Looks up an episode-specific still from TMDB by anime title + episode number.
 * Tries the top 2 search matches, seasons 1 and 2 each, same as the site did
 * directly. Caches misses too (short TTL via the 'episodes' bucket) so a
 * title with no TMDB match doesn't get re-searched on every request.
 */
export async function getEpisodeThumbnail(
  animeTitle: string,
  epNum: number,
  isList = false
): Promise<TmdbEpisodeThumbResult> {
  const log: string[] = [];

  if (!TMDB_API_KEY) {
    log.push('TMDB: skipped (no TMDB_API_KEY set on scraper)');
    return { result: null, log };
  }

  const cacheKey = `tmdb:epthumb:${animeTitle.toLowerCase()}:${epNum}`;
  if (!isList) {
    const cached = cacheGet<TmdbEpisodeThumb | null>(cacheKey);
    if (cached !== null) {
      log.push('TMDB: cache hit');
      return { result: cached, log };
    }
  }

  try {
    const srch = await tmdbClient.get('/search/tv', {
      params: { api_key: TMDB_API_KEY, query: animeTitle, language: 'en-US' },
    });
    const results = srch.data?.results ?? [];

    if (results.length === 0) {
      log.push(`TMDB: no show found for '${animeTitle}'`);
      cacheSet(cacheKey, null, 'episodes');
      return { result: null, log };
    }

    for (const show of results.slice(0, 2)) {
      const showId = show.id;
      log.push(`TMDB: trying '${show.name}' (ID ${showId})`);

      for (const season of [1, 2]) {
        try {
          const epRes = await tmdbClient.get(`/tv/${showId}/season/${season}/episode/${epNum}`, {
            params: { api_key: TMDB_API_KEY },
          });
          const still: string | null = epRes.data?.still_path ?? null;
          log.push(`TMDB ${show.name} s${season}e${epNum}: ${still ? `found ${still}` : 'no still'}`);

          if (still) {
            const result: TmdbEpisodeThumb = {
              showId,
              showName: show.name,
              season,
              stillPath: still,
              thumbnail: `https://image.tmdb.org/t/p/w780${still}`,
              thumbnailOriginal: `https://image.tmdb.org/t/p/original${still}`,
            };
            cacheSet(cacheKey, result, 'episodes');
            return { result, log };
          }
        } catch (e: any) {
          // 404 just means that season/episode doesn't exist for this show — keep trying
          const status = e?.response?.status;
          log.push(`TMDB s${season}e${epNum}: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
        }
      }
    }

    log.push(`TMDB: no still found for '${animeTitle}' ep ${epNum} in season 1 or 2`);
    cacheSet(cacheKey, null, 'episodes');
    return { result: null, log };
  } catch (e: any) {
    const status = e?.response?.status;
    log.push(`TMDB search: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
    return { result: null, log };
  }
}
