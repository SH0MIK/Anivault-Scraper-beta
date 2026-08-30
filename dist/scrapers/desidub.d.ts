export interface DesidubSearchResult {
    slug: string;
    title: string;
    image?: string;
}
export interface DesidubEpisode {
    num: number;
    id: string;
    title: string;
}
export interface DesidubServer {
    name: string;
    sourceId: string;
    type: 'sub' | 'dub' | 'raw';
    dubGroup?: string;
}
export interface DesidubSubtitle {
    lang: string;
    url: string;
    default?: boolean;
}
export interface DesidubStream {
    embedUrl: string;
    m3u8: string | null;
    mp4?: string | null;
    referer?: string;
    subtitles: DesidubSubtitle[];
    serverName: string;
    type: 'hls' | 'mp4' | 'iframe';
}
/**
 * Unpacks Dean Edwards packed JavaScript: eval(function(p,a,c,k,e,d)...)
 */
export declare function unpackPacked(packed: string): string;
/**
 * Decrypts AES-128-CBC encoded payloads (used by P2PPlay, RPMStream, UPNShare)
 */
export declare function decryptAesCbc(encryptedHex: string, keyStr?: string, ivStr?: string): string;
/**
 * Extracts .vtt/.srt subtitle tracks from HTML or unpacked JavaScript
 */
export declare function extractSubtitlesFromText(text: string): DesidubSubtitle[];
/**
 * Resolve VidMoly embed (https://vidmoly.net/embed-xxx.html)
 */
export declare function resolveVidmoly(embedUrl: string): Promise<{
    m3u8: string | null;
    subtitles: DesidubSubtitle[];
    referer: string;
} | null>;
/**
 * Resolve StreamRuby / RubyVidHub embed
 */
export declare function resolveStreamRuby(embedUrl: string): Promise<{
    m3u8: string | null;
    subtitles: DesidubSubtitle[];
    referer: string;
} | null>;
/**
 * Resolve AbyssPlayer embed — decrypts AES-CTR media payload
 */
export declare function resolveAbyss(embedUrl: string): Promise<{
    m3u8: string | null;
    subtitles: DesidubSubtitle[];
    referer: string;
} | null>;
/**
 * Resolve EarnVids / SmoothPre embed (from GDMirrorBot)
 */
export declare function resolveEarnVids(embedUrl: string): Promise<{
    m3u8: string | null;
    subtitles: DesidubSubtitle[];
    referer: string;
} | null>;
/**
 * Resolve RPMStream / UPNShare / P2PPlay embed (used in GDMirrorBot)
 */
export declare function resolveP2PPlay(embedUrl: string): Promise<{
    m3u8: string | null;
    subtitles: DesidubSubtitle[];
    referer: string;
} | null>;
/**
 * Resolve GDMirrorBot multi-mirror embed (https://gdmirrorbot.nl/embed/xxx)
 */
export declare function resolveGdMirrorBot(embedUrl: string): Promise<{
    m3u8: string | null;
    subtitles: DesidubSubtitle[];
    referer: string;
} | null>;
/**
 * Universal DesiDub Stream Resolver
 */
export declare function getDesidubStream(sourceIdOrUrl: string): Promise<DesidubStream | null>;
export interface DesidubSearchResult {
    slug: string;
    title: string;
    titleEn?: string;
    titleJp?: string;
    image?: string;
}
/**
 * Search DesiDubAnime for anime title
 */
export declare function searchDesidub(query: string): Promise<DesidubSearchResult[]>;
/**
 * Fuzzy-find the closest DesiDub show slug
 */
export declare function findDesidubSlug(title: string): Promise<string | null>;
/**
 * Get episode list for an anime slug on DesiDubAnime
 */
export declare function getDesidubEpisodes(slug: string): Promise<DesidubEpisode[]>;
/**
 * Extract streaming servers from an episode watch page
 */
export declare function getDesidubServers(episodeSlug: string): Promise<DesidubServer[]>;
//# sourceMappingURL=desidub.d.ts.map