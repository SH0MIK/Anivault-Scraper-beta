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

// ── Absolute episode -> TMDB (season, in-season episode) mapping ────────
// Long-running shonen (Naruto Shippuden, One Piece, Bleach, etc.) air as one
// continuous series on MAL/Jikan -- episode 1, 2, 3... straight through to
// the finale -- but TMDB models the same show as many separate seasons,
// each restarting its own numbering from episode 1. Naruto Shippuden alone
// is ~21 TMDB seasons. Without converting between the two, "episode 54"
// only ever means "season X, episode 54", which stops existing once every
// season TMDB has is shorter than 54 episodes.
interface TmdbSeasonInfo {
  season_number: number;
  episode_count: number;
}

async function getShowSeasons(showId: number, log: string[]): Promise<TmdbSeasonInfo[]> {
  const cacheKey = `tmdb:seasons:${showId}`;
  const cached = cacheGet<TmdbSeasonInfo[]>(cacheKey);
  if (cached) return cached;

  const res = await tmdbClient.get(`/tv/${showId}`, { params: { api_key: TMDB_API_KEY } });
  const seasons: TmdbSeasonInfo[] = (res.data?.seasons ?? [])
    .filter((s: any) => s.season_number > 0) // skip "Specials" (season 0) -- not part of the absolute count
    .map((s: any) => ({ season_number: s.season_number, episode_count: s.episode_count ?? 0 }))
    .sort((a: TmdbSeasonInfo, b: TmdbSeasonInfo) => a.season_number - b.season_number);

  cacheSet(cacheKey, seasons, 'mapping'); // 24h TTL -- a show's season structure essentially never changes
  log.push(`TMDB: '${showId}' has ${seasons.length} season(s) -- ${seasons.map((s) => `S${s.season_number}:${s.episode_count}`).join(', ')}`);
  return seasons;
}

/**
 * Walks the season list in order, subtracting each season's episode_count
 * from the absolute episode number until it lands inside one -- e.g. with
 * seasons [S1:32, S2:33, S3:18, ...] and absoluteEp=54: 54-32=22, 22<=33,
 * so that's season 2, episode 22. Returns null if absoluteEp is past every
 * season TMDB currently lists (e.g. a show that's still airing and TMDB
 * hasn't added the newest season yet).
 */
function mapAbsoluteEpisode(seasons: TmdbSeasonInfo[], absoluteEp: number): { season: number; epInSeason: number } | null {
  let remaining = absoluteEp;
  for (const s of seasons) {
    if (s.episode_count <= 0) continue;
    if (remaining <= s.episode_count) {
      return { season: s.season_number, epInSeason: remaining };
    }
    remaining -= s.episode_count;
  }
  return null;
}

/**
 * Looks up an episode-specific still from TMDB by anime title + episode number.
 *
 * `epNum` here is the ABSOLUTE episode number (MAL/Jikan-style -- counts
 * straight through 1..N across the whole series), but TMDB splits
 * long-running shows into many seasons, each restarting its own episode
 * numbering from 1 (Naruto Shippuden is ~21 TMDB seasons; One Piece is 20+).
 * So this first fetches the show's season list and walks it to figure out
 * which (season, in-season episode) absoluteEp actually falls under, before
 * ever hitting the per-episode endpoint -- trying `epNum` directly against
 * "season 1" / "season 2" (the old behavior) only ever worked for episodes
 * within whichever of those two seasons happened to be long enough, and
 * silently returned nothing for everything past that.
 *
 * `seasonHint` (title-derived, e.g. "Show II" -> season 2) and a bare
 * season-1/2 attempt at the raw epNum are still tried afterward as
 * fallbacks, in case the season list fetch fails or a show's numbering
 * doesn't line up with its season structure for some other reason.
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

    // Build (season, in-season episode) candidates to try, in priority order.
    const candidates: Array<{ season: number; epInSeason: number }> = [];

    try {
      const seasons = await getShowSeasons(showId, log);
      const mapped = mapAbsoluteEpisode(seasons, epNum);
      if (mapped) {
        log.push(`TMDB: absolute ep ${epNum} -> season ${mapped.season} ep ${mapped.epInSeason}`);
        candidates.push(mapped);
      } else {
        log.push(`TMDB: absolute ep ${epNum} is beyond every season TMDB lists for '${show.name}'`);
      }
    } catch (e: any) {
      log.push(`TMDB: couldn't fetch season list for '${show.name}' (${e?.message})`);
    }

    // Fallbacks: seasonHint and season 1/2, tried against the raw epNum --
    // covers shows without a clean season-list mapping (or where it's wrong).
    for (const season of [seasonHint, 1, 2]) {
      if (!season || season <= 0) continue;
      if (candidates.some((c) => c.season === season && c.epInSeason === epNum)) continue;
      candidates.push({ season, epInSeason: epNum });
    }

    for (const { season, epInSeason } of candidates) {
      try {
        const epRes = await tmdbClient.get(`/tv/${showId}/season/${season}/episode/${epInSeason}`, {
          params: { api_key: TMDB_API_KEY },
        });
        const still: string | null = epRes.data?.still_path ?? null;
        log.push(`TMDB ${show.name} s${season}e${epInSeason}: ${still ? `found ${still}` : 'no still'}`);

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
        log.push(`TMDB s${season}e${epInSeason}: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
      }
    }

    log.push(`TMDB: no still found for '${animeTitle}' ep ${epNum} (tried ${candidates.map((c) => `s${c.season}e${c.epInSeason}`).join(', ')})`);
    cacheSet(cacheKey, null, 'episodes');
    return { result: null, log };
  } catch (e: any) {
    const status = e?.response?.status;
    log.push(`TMDB search: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
    return { result: null, log };
  }
}
