"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheGet = cacheGet;
exports.cacheSet = cacheSet;
exports.cacheDel = cacheDel;
exports.cacheStats = cacheStats;
const node_cache_1 = __importDefault(require("node-cache"));
const cache = new node_cache_1.default({ useClones: false });
const TTL = {
    mapping: parseInt(process.env.CACHE_TTL_MAPPING || '86400'), // 24h
    episodes: parseInt(process.env.CACHE_TTL_EPISODES || '3600'), // 1h
    stream: parseInt(process.env.CACHE_TTL_STREAM || '300'), // 5min
};
function cacheGet(key) {
    return cache.get(key) ?? null;
}
function cacheSet(key, data, type = 'mapping') {
    cache.set(key, data, TTL[type]);
}
function cacheDel(key) {
    cache.del(key);
}
function cacheStats() {
    return cache.getStats();
}
//# sourceMappingURL=cache.js.map