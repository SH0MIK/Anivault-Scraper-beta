export interface AnikotoEpisode {
    num: number;
    id: string;
    title: string;
}
export interface AnikotoServer {
    name: string;
    sourceId: string;
    type: 'sub' | 'dub' | 'raw';
}
export interface AnikotoSubtitle {
    lang: string;
    url: string;
    default?: boolean;
}
export interface AnikotoStream {
    embedUrl: string;
    m3u8: string | null;
    referer?: string;
    subtitles: AnikotoSubtitle[];
    serverName: string;
    type: 'hls' | 'iframe';
}
interface AnikotoSearchResult {
    slug: string;
    title: string;
}
export declare function searchAnikoto(query: string): Promise<AnikotoSearchResult[]>;
export declare function findAnikotoSlug(title: string): Promise<string | null>;
export declare function getAnikotoEpisodes(slug: string): Promise<AnikotoEpisode[]>;
export declare function getAnikotoServers(episodeId: string): Promise<AnikotoServer[]>;
export declare function getAnikotoEmbedUrl(sourceId: string): Promise<AnikotoStream | null>;
export {};
//# sourceMappingURL=anikoto.d.ts.map