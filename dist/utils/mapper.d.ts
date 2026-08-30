export interface SiteIds {
    anilistId: number | null;
    malId: number | null;
    title: string;
    altTitle?: string | null;
    siteIds: {
        zoro?: string;
        gogoanime?: string;
        animeheaven?: string;
        anidao?: string;
        anikoto?: string;
        desidub?: string;
    };
}
export declare function malToAnilist(malId: number): Promise<number | null>;
export declare function getSiteIds(anilistId: number): Promise<SiteIds | null>;
export declare function getSiteIdsByMal(malId: number): Promise<SiteIds | null>;
export declare function searchAnilist(query: string): Promise<{
    id: number;
    malId: number | null;
    title: string;
    coverImage: string;
    episodes: number | null;
    status: string;
    format: string;
}[]>;
//# sourceMappingURL=mapper.d.ts.map