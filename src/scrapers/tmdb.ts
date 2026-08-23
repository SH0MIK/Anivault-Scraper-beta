import axios from 'axios';
import { cacheGet, cacheSet } from '../utils/cache';

// ══════════════════════════════════════════════════════════════
// TMDB — official REST API, not a scrape (same as anilist.ts).
//
// Ported from the site's src/lib/episode-thumb.ts "Source 2: TMDB" block so
// the Cloudflare Worker no longer has to call api.themoviedb.org itself.
//
// IMPORTANT: TMDB lists anime as ONE show with multiple seasons nested
// inside it -- there is no separate "Show Name II" / "Show Name Season 2"
// entry to search for. A title like "Saga of Tanya the Evil II" will never
// match a TMDB search; only "Saga of Tanya the Evil" (the base title) does,
// with Season 2 as season_number 2 under that same show. extractSeasonHint
// below strips the season marker off the title so search works, and reports
// which season number it implied so callers can target the right season.
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
  season: number | null;          // which season the poster came from (null = show-level fallback)
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

// ── Season-hint extraction ─────────────────────────────────────────────
// Strips a trailing season marker off an anime title and reports the
// implied season number, e.g.:
//   "Saga of Tanya the Evil II"    -> { base: "Saga of Tanya the Evil", season: 2 }
//   "Attack on Titan Season 3"     -> { base: "Attack on Titan", season: 3 }
//   "Kaguya-sama: Love Is War -Ultra Romantic-" (2nd/3rd season titles vary
//   per anime so this is best-effort; callers should keep the raw title as
//   a fallback search candidate too, which resolveTmdbTitles in routes.ts does).

const ROMAN_TO_NUM: Record<string, number> = {
  ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
};

const SEASON_WORD_PATTERNS: Array<{ re: RegExp; num: (m: RegExpMatchArray) => number }> = [
  { re: /\s+season\s+(\d{1,2})\s*$/i, num: (m) => parseInt(m[1], 10) },
  { re: /\s+(\d{1,2})(?:st|nd|rd|th)\s+season\s*$/i, num: (m) => parseInt(m[1], 10) },
  { re: /\s+part\s+(\d{1,2})\s*$/i, num: (m) => parseInt(m[1], 10) },
  { re: /\s+cour\s+(\d{1,2})\s*$/i, num: (m) => parseInt(m[1], 10) },
];

export function extractSeasonHint(title: string): { base: string; season: number | null } {
  for (const { re, num } of SEASON_WORD_PATTERNS) {
    const m = title.match(re);
    if (m) return { base: title.slice(0, m.index).trim(), season: num(m) };
  }

  // Trailing roman numeral, e.g. "Youjo Senki II"
  const romanMatch = title.match(/\s+(I{2,3}|IV|VI{0,3}|IX|X)\s*$/i);
  if (romanMatch) {
    const season = ROMAN_TO_NUM[romanMatch[1].toLowerCase()];
    if (season) return { base: title.slice(0, romanMatch.index).trim().replace(/[:\-–]\s*$/, ''), season };
  }

  // Trailing arabic digit (2-10 only, to avoid eating years like "2003")
  const digitMatch = title.match(/\s+(\d{1,2})\s*$/);
  if (digitMatch) {
    const n = parseInt(digitMatch[1], 10);
    if (n >= 2 && n <= 10) {
      return { base: title.slice(0, digitMatch.index).trim().replace(/[:\-–]\s*$/, ''), season: n };
    }
  }

  return { base: title, season: null };
}

// Different art types want different preferences:
// - posters/logos: prefer English (they carry title text), then textless
// - backdrops: prefer textless/no-language first (cleaner as a banner),
//   then English, since a banner with baked-in foreign text looks worse
//   than one with none.
function pickBestImage(arr: any[], mode: 'lang-first' | 'textless-first' = 'lang-first'): any | null {
  if (!arr || arr.length === 0) return null;
  const byVotes = [...arr].sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0));
  if (mode === 'textless-first') {
    return byVotes.find((i) => !i.iso_639_1) || byVotes.find((i) => i.iso_639_1 === 'en') || byVotes[0];
  }
  return byVotes.find((i) => i.iso_639_1 === 'en') || byVotes.find((i) => !i.iso_639_1) || byVotes[0];
}

// TMDB search/tv genre_id for "Animation". Used below to disambiguate shows
// that share a title with a non-anime entry (e.g. "One Piece" the anime vs.
// Netflix's 2023 live-action "One Piece" -- both come back from the same
// search query, and TMDB's own relevance ranking doesn't reliably put the
// anime first).
const ANIMATION_GENRE_ID = 16;

async function searchShow(animeTitle: string, log: string[]): Promise<{ id: number; name: string } | null> {
  const srch = await tmdbClient.get('/search/tv', {
    params: { api_key: TMDB_API_KEY, query: animeTitle, language: 'en-US' },
  });
  const results = srch.data?.results ?? [];
  if (results.length === 0) {
    log.push(`TMDB: no show found for '${animeTitle}'`);
    return null;
  }

  // Prefer a result that's actually animated AND Japanese-origin -- catches
  // cases like "One Piece" where a live-action adaptation of the same name
  // (different genre, different origin_country) outranks the anime in
  // TMDB's default search order. Falls back through progressively looser
  // criteria, then finally to whatever TMDB ranked first, so this never
  // returns nothing just because a match couldn't be scored.
  const isAnimated = (r: any) => Array.isArray(r.genre_ids) && r.genre_ids.includes(ANIMATION_GENRE_ID);
  const isJapanese = (r: any) => r.original_language === 'ja' || (Array.isArray(r.origin_country) && r.origin_country.includes('JP'));

  const show =
    results.find((r: any) => isAnimated(r) && isJapanese(r)) ||
    results.find((r: any) => isAnimated(r)) ||
    results.find((r: any) => isJapanese(r)) ||
    results[0];

  if (show !== results[0]) {
    log.push(`TMDB: '${results[0].name}' (ID ${results[0].id}) ranked first but isn't anime -- picked '${show.name}' (ID ${show.id}) instead`);
  }
  log.push(`TMDB: matched '${animeTitle}' -> '${show.name}' (ID ${show.id})`);
  return { id: show.id, name: show.name };
}

/**
 * Poster (cover), backdrop (banner), and logo for a show, by title.
 *
 * `seasonHint` (from extractSeasonHint, computed by the caller from the raw
 * MAL/AniList title before base-stripping) is used to fetch the
 * season-specific poster first -- TMDB posters differ per season (Season 2
 * gets its own key art) but backdrops/logos are show-level, shared across
 * all seasons. If the hinted season has no poster of its own, falls back to
 * season 1's poster, then the show-level poster, same idea as the site's
 * own "fallback to season 1" behavior.
 */
export async function getAnimeImages(
  animeTitle: string,
  seasonHint: number | null = null,
  isList = false
): Promise<TmdbAnimeImagesResult> {
  const log: string[] = [];

  if (!TMDB_API_KEY) {
    log.push('TMDB: skipped (no TMDB_API_KEY set on scraper)');
    return { result: null, log };
  }

  const cacheKey = `tmdb:images:${animeTitle.toLowerCase()}:s${seasonHint ?? ''}`;
  if (!isList) {
    const cached = cacheGet<TmdbAnimeImages | null>(cacheKey);
    if (cached !== null) {
      log.push('TMDB: cache hit');
      return { result: cached, log };
    }
  }

  try {
    const show = await searchShow(animeTitle, log);
    if (!show) {
      cacheSet(cacheKey, null, 'mapping');
      return { result: null, log };
    }
    const showId = show.id;

    const imgRes = await tmdbClient.get(`/tv/${showId}/images`, {
      params: { api_key: TMDB_API_KEY, include_image_language: 'en,ja,null' },
    });
    const showPosters: any[] = imgRes.data?.posters ?? [];
    const backdrops: any[] = imgRes.data?.backdrops ?? [];
    const logos: any[] = imgRes.data?.logos ?? [];
    log.push(`TMDB show-level images: ${showPosters.length} posters, ${backdrops.length} backdrops, ${logos.length} logos`);

    const backdrop = pickBestImage(backdrops, 'textless-first');
    const logo = pickBestImage(logos, 'lang-first');

    // Poster: try the hinted season first, then season 1 as fallback, then
    // whatever show-level poster exists.
    let poster: any | null = null;
    let posterSeason: number | null = null;
    const seasonsToTry = [...new Set([seasonHint, 1].filter((s): s is number => !!s && s > 0))];

    for (const s of seasonsToTry) {
      try {
        const seasonImgRes = await tmdbClient.get(`/tv/${showId}/season/${s}/images`, {
          params: { api_key: TMDB_API_KEY, include_image_language: 'en,ja,null' },
        });
        const seasonPosters: any[] = seasonImgRes.data?.posters ?? [];
        log.push(`TMDB season ${s} posters: ${seasonPosters.length}`);
        const best = pickBestImage(seasonPosters, 'lang-first');
        if (best) {
          poster = best;
          posterSeason = s;
          log.push(`TMDB: using season ${s} poster`);
          break;
        }
      } catch (e: any) {
        const status = e?.response?.status;
        log.push(`TMDB season ${s} images: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
      }
    }

    if (!poster) {
      poster = pickBestImage(showPosters, 'lang-first');
      if (poster) log.push('TMDB: using show-level poster (no season-specific poster found)');
    }

    if (!poster && !backdrop && !logo) {
      log.push('TMDB: no usable images found at all');
      cacheSet(cacheKey, null, 'mapping');
      return { result: null, log };
    }

    const result: TmdbAnimeImages = {
      showId,
      showName: show.name,
      season: posterSeason,
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
 *
 * `seasonHint` (see getAnimeImages) is tried first if given, then season 1,
 * then season 2, deduped -- instead of blindly always trying 1 then 2, which
 * broke once a title carried a season marker the base-title search couldn't
 * see through anyway.
 */
export async function getEpisodeThumbnail(
  animeTitle: string,
  epNum: number,
  seasonHint: number | null = null,
  isList = false
): Promise<TmdbEpisodeThumbResult> {
  const log: string[] = [];

  if (!TMDB_API_KEY) {
    log.push('TMDB: skipped (no TMDB_API_KEY set on scraper)');
    return { result: null, log };
  }

  const cacheKey = `tmdb:epthumb:${animeTitle.toLowerCase()}:s${seasonHint ?? ''}:${epNum}`;
  if (!isList) {
    const cached = cacheGet<TmdbEpisodeThumb | null>(cacheKey);
    if (cached !== null) {
      log.push('TMDB: cache hit');
      return { result: cached, log };
    }
  }

  try {
    const show = await searchShow(animeTitle, log);
    if (!show) {
      cacheSet(cacheKey, null, 'episodes');
      return { result: null, log };
    }
    const showId = show.id;

    const seasonsToTry = [...new Set([seasonHint, 1, 2].filter((s): s is number => !!s && s > 0))];

    for (const season of seasonsToTry) {
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

    log.push(`TMDB: no still found for '${animeTitle}' ep ${epNum} in seasons tried (${seasonsToTry.join(', ')})`);
    cacheSet(cacheKey, null, 'episodes');
    return { result: null, log };
  } catch (e: any) {
    const status = e?.response?.status;
    log.push(`TMDB search: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
    return { result: null, log };
  }
}
