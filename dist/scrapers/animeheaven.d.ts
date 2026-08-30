export interface HeavenSearchResult {
    id: string;
    title: string;
    url: string;
    image?: string;
}
export interface HeavenEpisode {
    id: string;
    num: number;
    title: string;
}
export interface HeavenServer {
    name: string;
    sourceId: string;
    type: 'sub';
}
export interface HeavenStream {
    embedUrl: string;
    streamUrl: string;
    mp4: string;
    m3u8: null;
    type: 'mp4';
    servers: string[];
}
export declare function searchAnimeHeaven(query: string): Promise<HeavenSearchResult[]>;
export declare function findAnimeHeavenId(title: string): Promise<string | null>;
export declare function getHeavenEpisodes(animeId: string): Promise<HeavenEpisode[]>;
export declare function getHeavenServers(episodeId: string): Promise<HeavenServer[]>;
export declare function getHeavenStream(episodeId: string): Promise<HeavenStream | null>;
//# sourceMappingURL=animeheaven.d.ts.map