export interface TmdbEpisodeThumb {
    showId: number;
    showName: string;
    season: number;
    stillPath: string;
    thumbnail: string;
    thumbnailOriginal: string;
}
export interface TmdbEpisodeThumbResult {
    result: TmdbEpisodeThumb | null;
    log: string[];
}
export interface TmdbAnimeImages {
    showId: number;
    showName: string;
    season: number | null;
    poster: string | null;
    posterOriginal: string | null;
    backdrop: string | null;
    backdropOriginal: string | null;
    logo: string | null;
    logoOriginal: string | null;
}
export interface TmdbAnimeImagesResult {
    result: TmdbAnimeImages | null;
    log: string[];
}
export declare function extractSeasonHint(title: string): {
    base: string;
    season: number | null;
};
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
export declare function getAnimeImages(animeTitle: string, seasonHint?: number | null, isList?: boolean): Promise<TmdbAnimeImagesResult>;
/**
 * Looks up an episode-specific still from TMDB by anime title + episode number.
 *
 * `epNum` here is the ABSOLUTE episode number (MAL/Jikan-style -- counts
 * straight through 1..N across the whole series), but TMDB splits
 * long-running shows into many seasons (Naruto Shippuden is ~20 TMDB
 * seasons; One Piece is 20+). So this first fetches the show's season list
 * to figure out which season absoluteEp falls under, then tries that
 * episode number two ways within that season -- see mapAbsoluteEpisode for
 * why there are two candidates, not one; TMDB isn't consistent about
 * whether a season resets its own episode numbering back to 1.
 *
 * `seasonHint` (title-derived, e.g. "Show II" -> season 2) and a bare
 * season-1/2 attempt at the raw epNum are still tried afterward as further
 * fallbacks, in case the season list fetch fails entirely.
 */
export declare function getEpisodeThumbnail(animeTitle: string, epNum: number, seasonHint?: number | null, isList?: boolean): Promise<TmdbEpisodeThumbResult>;
export interface TmdbEpisodeInfo {
    showId: number;
    showName: string;
    season: number;
    title: string;
    aired: string | null;
}
export interface TmdbEpisodeInfoResult {
    result: TmdbEpisodeInfo | null;
    log: string[];
}
/**
 * Episode title + air date from TMDB, by anime title + absolute episode
 * number. Same show-search + absolute->season/episode mapping as
 * getEpisodeThumbnail (see buildEpisodeCandidates), just pulling name/
 * air_date off the episode object instead of still_path -- kept as a
 * separate function/cache key since a still can be missing on an episode
 * that otherwise has a title+date (or vice versa), so callers resolving
 * thumbnail vs. info independently shouldn't have one's cache miss cost
 * the other a redundant fetch.
 */
export declare function getEpisodeInfo(animeTitle: string, epNum: number, seasonHint?: number | null, isList?: boolean): Promise<TmdbEpisodeInfoResult>;
/**
 * Total episode count TMDB currently lists for a show (sum of episode_count
 * across all non-special seasons). Used to detect when MAL's scraped
 * episode-list page is undercounting an airing show (MAL can lag a scrape
 * or drop a row) so /api/episode can pad in the missing tail episodes from
 * TMDB/AniList/Kitsu instead of silently reporting a stale count.
 */
export declare function getShowEpisodeCount(animeTitle: string): Promise<{
    showId: number;
    count: number;
} | null>;
export interface TmdbEpisodeData {
    showId: number;
    showName: string;
    season: number;
    title: string | null;
    aired: string | null;
    stillPath: string | null;
    thumbnail: string | null;
    thumbnailOriginal: string | null;
}
export interface TmdbEpisodeDataResult {
    result: TmdbEpisodeData | null;
    log: string[];
}
export declare function getEpisodeData(animeTitle: string, epNum: number, seasonHint?: number | null, isList?: boolean, expectedAired?: string | null): Promise<TmdbEpisodeDataResult>;
//# sourceMappingURL=tmdb.d.ts.map