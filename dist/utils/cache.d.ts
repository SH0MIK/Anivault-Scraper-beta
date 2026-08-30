import NodeCache from 'node-cache';
declare const TTL: {
    mapping: number;
    episodes: number;
    stream: number;
};
export declare function cacheGet<T>(key: string): T | null;
export declare function cacheSet(key: string, data: any, type?: keyof typeof TTL): void;
export declare function cacheDel(key: string): void;
export declare function cacheStats(): NodeCache.Stats;
export {};
//# sourceMappingURL=cache.d.ts.map