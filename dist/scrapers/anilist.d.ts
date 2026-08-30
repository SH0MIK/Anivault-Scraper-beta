export interface AniListSeasonAnime {
    idMal: number | null;
    title: {
        romaji: string | null;
        english: string | null;
    };
    description: string | null;
    bannerImage: string | null;
    coverImage: {
        large: string | null;
        extraLarge: string | null;
    };
    genres: string[];
    episodes: number | null;
    averageScore: number | null;
    format: string | null;
    status: string | null;
}
export declare function getSeasonNow(): Promise<{
    season: string;
    seasonYear: number;
    media: AniListSeasonAnime[];
}>;
export declare function getTopBanners(limit?: number): Promise<Record<string, string>>;
export interface AniListStreamingEpisode {
    title: string | null;
    thumbnail: string | null;
    url: string | null;
    site: string | null;
}
export declare function getStreamingEpisodes(malId: number): Promise<AniListStreamingEpisode[]>;
export interface AniListAnimeImages {
    idMal: number;
    title: string | null;
    poster: string | null;
    posterOriginal: string | null;
    cover: string | null;
    coverOriginal: string | null;
}
export interface AniListAnimeImagesResult {
    result: AniListAnimeImages | null;
    log: string[];
}
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
export declare function getAnimeImages(malId: number, isList?: boolean): Promise<AniListAnimeImagesResult>;
//# sourceMappingURL=anilist.d.ts.map