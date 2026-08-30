"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSeasonNow = getSeasonNow;
exports.getTopBanners = getTopBanners;
exports.getStreamingEpisodes = getStreamingEpisodes;
exports.getAnimeImages = getAnimeImages;
const fetch_1 = require("../utils/fetch");
const cache_1 = require("../utils/cache");
function currentSeason() {
    const now = new Date();
    const month = now.getUTCMonth() + 1;
    const seasonYear = now.getUTCFullYear();
    const season = month <= 3 ? 'WINTER' : month <= 6 ? 'SPRING' : month <= 9 ? 'SUMMER' : 'FALL';
    return { season, seasonYear };
}
const SEASON_QUERY = `
  query ($season: MediaSeason, $seasonYear: Int) {
    Page(page: 1, perPage: 50) {
      media(season: $season, seasonYear: $seasonYear, type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
        idMal
        title { romaji english }
        description(asHtml: false)
        bannerImage
        coverImage { large extraLarge }
        genres
        episodes
        averageScore
        format
        status
      }
    }
  }`;
// Cached under a season+year key (same convention the site's own KV cache
// uses) so a Railway cold-restart doesn't cost an extra AniList round trip
// per request -- only the first request each hour (see cache.ts 'episodes'
// TTL) actually hits AniList.
async function getSeasonNow() {
    const { season, seasonYear } = currentSeason();
    const cacheKey = `anilist:season:${season}:${seasonYear}`;
    const cached = (0, cache_1.cacheGet)(cacheKey);
    if (cached)
        return { season, seasonYear, media: cached };
    const res = await fetch_1.anilistClient.post('', { query: SEASON_QUERY, variables: { season, seasonYear } });
    if (res.data?.errors?.length) {
        throw new Error('AniList GraphQL error: ' + JSON.stringify(res.data.errors).slice(0, 300));
    }
    const media = res.data?.data?.Page?.media ?? [];
    (0, cache_1.cacheSet)(cacheKey, media, 'episodes');
    return { season, seasonYear, media };
}
const TOP_BANNERS_QUERY = `
  query ($page: Int) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage }
      media(type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
        idMal
        bannerImage
      }
    }
  }`;
// Top-N-by-popularity bannerImage map (malId -> bannerImage) -- covers
// older/finished popular titles the season list above can never include
// (Attack on Titan, Naruto, etc). Effectively static day to day, so this
// gets the full 24h 'mapping' TTL rather than refetching per call.
async function getTopBanners(limit = 200) {
    const cacheKey = `anilist:top-banners:${limit}`;
    const cached = (0, cache_1.cacheGet)(cacheKey);
    if (cached)
        return cached;
    const map = {};
    const perPage = 50;
    const pages = Math.ceil(limit / perPage);
    for (let page = 1; page <= pages; page++) {
        const res = await fetch_1.anilistClient.post('', { query: TOP_BANNERS_QUERY, variables: { page } });
        if (res.data?.errors?.length)
            break; // keep whatever pages already succeeded
        const media = res.data?.data?.Page?.media ?? [];
        for (const m of media) {
            if (m.idMal && m.bannerImage)
                map[String(m.idMal)] = m.bannerImage;
        }
        if (!res.data?.data?.Page?.pageInfo?.hasNextPage)
            break;
    }
    (0, cache_1.cacheSet)(cacheKey, map, 'mapping');
    return map;
}
const STREAMING_EPISODES_QUERY = `
  query ($malId: Int) {
    Media(idMal: $malId, type: ANIME) {
      streamingEpisodes { title thumbnail url site }
    }
  }`;
// Per-title episode thumbnails (AniList's "streamingEpisodes" block --
// usually sourced from whichever streaming partner AniList itself tracks
// stills for, most often Crunchyroll). This was previously called directly
// from the site's episode-thumb.ts via graphql.anilist.co, which -- same as
// the season data -- silently always failed on Cloudflare Workers (blocked
// IP range), so this source has effectively never worked. Routed through
// here now for the same reason as getSeasonNow/getTopBanners above.
async function getStreamingEpisodes(malId) {
    const cacheKey = `anilist:episodes:${malId}`;
    const cached = (0, cache_1.cacheGet)(cacheKey);
    if (cached)
        return cached;
    const res = await fetch_1.anilistClient.post('', { query: STREAMING_EPISODES_QUERY, variables: { malId } });
    if (res.data?.errors?.length) {
        throw new Error('AniList GraphQL error: ' + JSON.stringify(res.data.errors).slice(0, 300));
    }
    const episodes = res.data?.data?.Media?.streamingEpisodes ?? [];
    (0, cache_1.cacheSet)(cacheKey, episodes, 'episodes');
    return episodes;
}
const ANIME_IMAGES_QUERY = `
  query ($malId: Int) {
    Media(idMal: $malId, type: ANIME) {
      idMal
      title { romaji english }
      coverImage { large extraLarge }
      bannerImage
    }
  }`;
/**
 * Poster + cover (banner) art for a MAL ID, shaped to match tmdb.ts's and
 * kitsu.ts's getAnimeImages so routes.ts's combined /api/anime endpoint can
 * fall through TMDB -> Kitsu -> AniList interchangeably (same as
 * resolveEpisodeThumbnail already does for episode thumbnails).
 *
 * NOTE: AniList's own field names are the reverse of the poster/cover
 * naming used here (and in kitsu.ts). AniList's `coverImage` is the
 * portrait key art -- mapped to `poster` below -- and AniList's
 * `bannerImage` is the wide banner -- mapped to `cover` below.
 */
async function getAnimeImages(malId, isList = false) {
    const log = [];
    const cacheKey = `anilist:images:${malId}`;
    if (!isList) {
        const cached = (0, cache_1.cacheGet)(cacheKey);
        if (cached !== null) {
            log.push('AniList images: cache hit');
            return { result: cached, log };
        }
    }
    try {
        const res = await fetch_1.anilistClient.post('', { query: ANIME_IMAGES_QUERY, variables: { malId } });
        if (res.data?.errors?.length) {
            log.push(`AniList images: GraphQL error (${JSON.stringify(res.data.errors).slice(0, 200)})`);
            (0, cache_1.cacheSet)(cacheKey, null, 'mapping');
            return { result: null, log };
        }
        const media = res.data?.data?.Media;
        if (!media) {
            log.push(`AniList images: no media found for MAL ID ${malId}`);
            (0, cache_1.cacheSet)(cacheKey, null, 'mapping');
            return { result: null, log };
        }
        const poster = media.coverImage?.large ?? media.coverImage?.extraLarge ?? null;
        const posterOriginal = media.coverImage?.extraLarge ?? poster;
        const cover = media.bannerImage ?? null;
        if (!poster && !cover) {
            log.push(`AniList images: MAL ID ${malId} has no poster or banner image`);
            (0, cache_1.cacheSet)(cacheKey, null, 'mapping');
            return { result: null, log };
        }
        const result = {
            idMal: malId,
            title: media.title?.english || media.title?.romaji || null,
            poster,
            posterOriginal,
            cover,
            coverOriginal: cover,
        };
        log.push(`AniList images: found (poster: ${poster ? 'yes' : 'no'}, cover: ${cover ? 'yes' : 'no'})`);
        (0, cache_1.cacheSet)(cacheKey, result, 'mapping');
        return { result, log };
    }
    catch (e) {
        log.push(`AniList images: request failed (${e?.message})`);
        return { result: null, log };
    }
}
//# sourceMappingURL=anilist.js.map