export interface KitsuEpisodeThumb {
    kitsuAnimeId: number;
    episodeId: number;
    size: string;
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
export declare function getKitsuAnimeId(malId: number | null, animeTitle: string | null, log: string[]): Promise<number | null>;
export interface KitsuAnimeImages {
    kitsuAnimeId: number;
    canonicalTitle: string | null;
    poster: string | null;
    posterOriginal: string | null;
    cover: string | null;
    coverOriginal: string | null;
}
export interface KitsuAnimeImagesResult {
    result: KitsuAnimeImages | null;
    kitsuAnimeId: number | null;
    log: string[];
}
/**
 * Poster + cover (banner) art for a known Kitsu anime ID. Kitsu doesn't
 * have a logo art type at all (only posterImage/coverImage), and unlike
 * TMDB there's no per-season art either -- each Kitsu anime ID has exactly
 * one poster/cover pair, so there's no season-fallback logic needed here.
 */
export declare function getAnimeImages(kitsuAnimeId: number, isList?: boolean): Promise<KitsuAnimeImagesResult>;
/**
 * Episode-specific thumbnail for a known Kitsu anime ID + episode number.
 * Tries thumbnail sizes largest-first, same order episode-thumb.ts used.
 */
export declare function getEpisodeThumbnail(kitsuAnimeId: number, epNum: number, isList?: boolean): Promise<KitsuEpisodeThumbResult>;
export interface KitsuEpisodeInfo {
    kitsuAnimeId: number;
    episodeId: number;
    title: string;
    titleJapanese: string | null;
    aired: string | null;
}
export interface KitsuEpisodeInfoResult {
    result: KitsuEpisodeInfo | null;
    kitsuAnimeId: number | null;
    log: string[];
}
/**
 * Episode title + air date for a known Kitsu anime ID + episode number.
 * Last-resort source in the TMDB -> MAL -> AniList -> Kitsu episode-info
 * priority chain, same reasoning as getEpisodeThumbnail above: whichever
 * of the four actually has the row wins.
 */
export declare function getEpisodeInfo(kitsuAnimeId: number, epNum: number, isList?: boolean): Promise<KitsuEpisodeInfoResult>;
export interface KitsuEpisodeData {
    kitsuAnimeId: number;
    episodeId: number;
    title: string | null;
    titleJapanese: string | null;
    aired: string | null;
    thumbnail: string | null;
}
export interface KitsuEpisodeDataResult {
    result: KitsuEpisodeData | null;
    kitsuAnimeId: number | null;
    log: string[];
}
/**
 * Combined title+air-date+thumbnail fetch for a known Kitsu anime ID +
 * episode number -- one GET instead of the two identical
 * `/anime/{id}/episodes?filter[number]=` requests getEpisodeThumbnail and
 * getEpisodeInfo each made for the same row. Use this from a caller that
 * wants both (the /api/episode route); the separate functions above stay
 * for callers that only need one field.
 */
export declare function getEpisodeData(kitsuAnimeId: number, epNum: number, isList?: boolean): Promise<KitsuEpisodeDataResult>;
//# sourceMappingURL=kitsu.d.ts.map