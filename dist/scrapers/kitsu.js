"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getKitsuAnimeId = getKitsuAnimeId;
exports.getAnimeImages = getAnimeImages;
exports.getEpisodeThumbnail = getEpisodeThumbnail;
exports.getEpisodeInfo = getEpisodeInfo;
exports.getEpisodeData = getEpisodeData;
const axios_1 = __importDefault(require("axios"));
const cache_1 = require("../utils/cache");
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
const kitsuClient = axios_1.default.create({
    baseURL: 'https://kitsu.app/api/edge',
    timeout: 10000,
    headers: { Accept: 'application/vnd.api+json' },
});
/**
 * Resolves a MAL ID (and/or title) to a Kitsu anime ID: MAL mapping first,
 * title search as fallback -- exactly the two steps episode-thumb.ts used.
 * Cached under the long-lived 'mapping' bucket since this pairing never
 * changes for a given MAL ID/title.
 */
async function getKitsuAnimeId(malId, animeTitle, log) {
    const cacheKey = malId ? `kitsu:id:mal:${malId}` : `kitsu:id:title:${(animeTitle ?? '').toLowerCase()}`;
    const cached = (0, cache_1.cacheGet)(cacheKey);
    if (cached !== null) {
        log.push('Kitsu ID lookup: cache hit');
        return cached;
    }
    let kitsuAnimeId = null;
    if (malId) {
        try {
            const mapRes = await kitsuClient.get('/mappings', {
                params: { 'filter[externalSite]': 'myanimelist/anime', 'filter[externalId]': malId, include: 'item' },
            });
            for (const item of mapRes.data?.included ?? []) {
                if (item.type === 'anime') {
                    kitsuAnimeId = parseInt(item.id, 10);
                    break;
                }
            }
            log.push(`Kitsu mapping: ${kitsuAnimeId ? `found ID ${kitsuAnimeId}` : 'not found'}`);
        }
        catch (e) {
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
        }
        catch (e) {
            log.push(`Kitsu title search: request failed (${e?.response?.status ?? e?.message})`);
        }
    }
    (0, cache_1.cacheSet)(cacheKey, kitsuAnimeId, 'mapping');
    return kitsuAnimeId;
}
/**
 * Poster + cover (banner) art for a known Kitsu anime ID. Kitsu doesn't
 * have a logo art type at all (only posterImage/coverImage), and unlike
 * TMDB there's no per-season art either -- each Kitsu anime ID has exactly
 * one poster/cover pair, so there's no season-fallback logic needed here.
 */
async function getAnimeImages(kitsuAnimeId, isList = false) {
    const log = [];
    const cacheKey = `kitsu:images:${kitsuAnimeId}`;
    if (!isList) {
        const cached = (0, cache_1.cacheGet)(cacheKey);
        if (cached !== null) {
            log.push('Kitsu images: cache hit');
            return { result: cached, kitsuAnimeId, log };
        }
    }
    try {
        const animeRes = await kitsuClient.get(`/anime/${kitsuAnimeId}`);
        const attrs = animeRes.data?.data?.attributes;
        if (!attrs) {
            log.push(`Kitsu anime ${kitsuAnimeId}: not found`);
            (0, cache_1.cacheSet)(cacheKey, null, 'mapping');
            return { result: null, kitsuAnimeId, log };
        }
        const posterImg = attrs.posterImage ?? {};
        const coverImg = attrs.coverImage ?? {};
        log.push(`Kitsu images: poster sizes [${Object.keys(posterImg).join(', ') || 'none'}], cover sizes [${Object.keys(coverImg).join(', ') || 'none'}]`);
        const poster = posterImg.large ?? posterImg.medium ?? posterImg.original ?? null;
        const posterOriginal = posterImg.original ?? poster;
        const cover = coverImg.large ?? coverImg.original ?? null;
        const coverOriginal = coverImg.original ?? cover;
        if (!poster && !cover) {
            log.push(`Kitsu anime ${kitsuAnimeId}: no poster or cover image available`);
            (0, cache_1.cacheSet)(cacheKey, null, 'mapping');
            return { result: null, kitsuAnimeId, log };
        }
        const result = {
            kitsuAnimeId,
            canonicalTitle: attrs.canonicalTitle ?? null,
            poster,
            posterOriginal,
            cover,
            coverOriginal,
        };
        (0, cache_1.cacheSet)(cacheKey, result, 'mapping');
        return { result, kitsuAnimeId, log };
    }
    catch (e) {
        const status = e?.response?.status;
        log.push(`Kitsu anime ${kitsuAnimeId}: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
        return { result: null, kitsuAnimeId, log };
    }
}
/**
 * Episode-specific thumbnail for a known Kitsu anime ID + episode number.
 * Tries thumbnail sizes largest-first, same order episode-thumb.ts used.
 */
async function getEpisodeThumbnail(kitsuAnimeId, epNum, isList = false) {
    const log = [];
    const cacheKey = `kitsu:epthumb:${kitsuAnimeId}:${epNum}`;
    if (!isList) {
        const cached = (0, cache_1.cacheGet)(cacheKey);
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
            (0, cache_1.cacheSet)(cacheKey, null, 'episodes');
            return { result: null, kitsuAnimeId, log };
        }
        const imgs = epData.attributes?.thumbnail ?? {};
        log.push(`Kitsu ep ${epNum} thumbnail: ${Object.keys(imgs).length === 0 ? 'empty (no image on Kitsu)' : JSON.stringify(imgs)}`);
        for (const size of ['original', 'large', 'medium', 'small', 'tiny']) {
            if (imgs[size]) {
                const result = {
                    kitsuAnimeId,
                    episodeId: parseInt(epData.id, 10),
                    size,
                    thumbnail: imgs[size],
                };
                (0, cache_1.cacheSet)(cacheKey, result, 'episodes');
                return { result, kitsuAnimeId, log };
            }
        }
        log.push(`Kitsu ep ${epNum}: no image on Kitsu`);
        (0, cache_1.cacheSet)(cacheKey, null, 'episodes');
        return { result: null, kitsuAnimeId, log };
    }
    catch (e) {
        const status = e?.response?.status;
        log.push(`Kitsu ep: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
        return { result: null, kitsuAnimeId, log };
    }
}
/**
 * Episode title + air date for a known Kitsu anime ID + episode number.
 * Last-resort source in the TMDB -> MAL -> AniList -> Kitsu episode-info
 * priority chain, same reasoning as getEpisodeThumbnail above: whichever
 * of the four actually has the row wins.
 */
async function getEpisodeInfo(kitsuAnimeId, epNum, isList = false) {
    const log = [];
    const cacheKey = `kitsu:epinfo:${kitsuAnimeId}:${epNum}`;
    if (!isList) {
        const cached = (0, cache_1.cacheGet)(cacheKey);
        if (cached !== null) {
            log.push('Kitsu ep info: cache hit');
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
            (0, cache_1.cacheSet)(cacheKey, null, 'episodes');
            return { result: null, kitsuAnimeId, log };
        }
        const attrs = epData.attributes ?? {};
        const title = attrs.canonicalTitle ?? attrs.titles?.en ?? attrs.titles?.en_us ?? null;
        const titleJapanese = attrs.titles?.ja_jp ?? null;
        const aired = attrs.airdate ?? null;
        if (!title) {
            log.push(`Kitsu ep ${epNum}: no title on Kitsu`);
            (0, cache_1.cacheSet)(cacheKey, null, 'episodes');
            return { result: null, kitsuAnimeId, log };
        }
        const result = { kitsuAnimeId, episodeId: parseInt(epData.id, 10), title, titleJapanese, aired };
        (0, cache_1.cacheSet)(cacheKey, result, 'episodes');
        log.push(`Kitsu ep ${epNum}: found '${title}'`);
        return { result, kitsuAnimeId, log };
    }
    catch (e) {
        const status = e?.response?.status;
        log.push(`Kitsu ep info: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
        return { result: null, kitsuAnimeId, log };
    }
}
/**
 * Combined title+air-date+thumbnail fetch for a known Kitsu anime ID +
 * episode number -- one GET instead of the two identical
 * `/anime/{id}/episodes?filter[number]=` requests getEpisodeThumbnail and
 * getEpisodeInfo each made for the same row. Use this from a caller that
 * wants both (the /api/episode route); the separate functions above stay
 * for callers that only need one field.
 */
async function getEpisodeData(kitsuAnimeId, epNum, isList = false) {
    const log = [];
    const cacheKey = `kitsu:epdata:${kitsuAnimeId}:${epNum}`;
    if (!isList) {
        const cached = (0, cache_1.cacheGet)(cacheKey);
        if (cached !== null) {
            log.push('Kitsu ep data: cache hit');
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
            (0, cache_1.cacheSet)(cacheKey, null, 'episodes');
            return { result: null, kitsuAnimeId, log };
        }
        const attrs = epData.attributes ?? {};
        const title = attrs.canonicalTitle ?? attrs.titles?.en ?? attrs.titles?.en_us ?? null;
        const titleJapanese = attrs.titles?.ja_jp ?? null;
        const aired = attrs.airdate ?? null;
        const imgs = attrs.thumbnail ?? {};
        let thumbnail = null;
        for (const size of ['original', 'large', 'medium', 'small', 'tiny']) {
            if (imgs[size]) {
                thumbnail = imgs[size];
                break;
            }
        }
        if (!title && !thumbnail) {
            log.push(`Kitsu ep ${epNum}: no title or thumbnail on Kitsu`);
            (0, cache_1.cacheSet)(cacheKey, null, 'episodes');
            return { result: null, kitsuAnimeId, log };
        }
        const result = { kitsuAnimeId, episodeId: parseInt(epData.id, 10), title, titleJapanese, aired, thumbnail };
        (0, cache_1.cacheSet)(cacheKey, result, 'episodes');
        log.push(`Kitsu ep ${epNum}: found (title=${!!title}, thumbnail=${!!thumbnail})`);
        return { result, kitsuAnimeId, log };
    }
    catch (e) {
        const status = e?.response?.status;
        log.push(`Kitsu ep data: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
        return { result: null, kitsuAnimeId, log };
    }
}
//# sourceMappingURL=kitsu.js.map