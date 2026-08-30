export interface StreamResult {
    m3u8: string;
    type: 'hls';
    subtitles: {
        lang: string;
        url: string;
        default?: boolean;
    }[];
    intro?: {
        start: number;
        end: number;
    };
    outro?: {
        start: number;
        end: number;
    };
}
export declare function resolveMegacloud(embedUrl: string): Promise<StreamResult | null>;
export declare function resolveVidstreaming(embedUrl: string): Promise<StreamResult | null>;
export declare function resolveEmbed(embedUrl: string): Promise<StreamResult | null>;
//# sourceMappingURL=megacloud.d.ts.map