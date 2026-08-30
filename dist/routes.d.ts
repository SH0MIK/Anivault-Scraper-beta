declare const router: import("express-serve-static-core").Router;
export interface ResolvedEpisode {
    title: string | null;
    titleJapanese: string | null;
    aired: string | null;
    filler: boolean | null;
    recap: boolean | null;
    infoSource: 'tmdb' | 'mal' | 'anilist' | 'kitsu' | null;
    thumbnail: string | null;
    thumbnailSource: 'tmdb' | 'kitsu' | 'anilist' | null;
    log: string[];
}
export interface ResolvedAnimeArt {
    poster: string | null;
    posterSource: 'tmdb' | 'kitsu' | 'anilist' | null;
    cover: string | null;
    coverSource: 'tmdb' | 'kitsu' | 'anilist' | null;
    logo: string | null;
    logoSource: 'tmdb' | null;
    log: string[];
}
export default router;
//# sourceMappingURL=routes.d.ts.map