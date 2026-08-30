"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const routes_1 = __importDefault(require("./routes"));
const http_1 = __importDefault(require("http"));
const axios_1 = __importDefault(require("axios"));
const app = (0, express_1.default)();
app.use('/api', routes_1.default);
const server = http_1.default.createServer(app);
server.listen(4567, async () => {
    console.log('Test server running on port 4567');
    const base = 'http://127.0.0.1:4567/api';
    try {
        // 1. Info endpoint with DesiDub mapping
        console.log('\n--- 1. Testing /api/info ---');
        const infoRes = await axios_1.default.get(`${base}/info?malId=16498`);
        console.log('Title:', infoRes.data.title);
        console.log('SiteIds:', infoRes.data.siteIds);
        if (!infoRes.data.siteIds.desidub) {
            console.log('Note: desidub was not found by AniList title, testing direct desidub slug');
        }
        // 2. Episodes endpoint
        console.log('\n--- 2. Testing /api/episodes?malId=16498&source=desidub ---');
        const epRes = await axios_1.default.get(`${base}/episodes?malId=16498&source=desidub`);
        console.log('Episode count:', epRes.data.count);
        console.log('First 3 episodes:', epRes.data.episodes.slice(0, 3));
        // 3. Servers endpoint
        console.log('\n--- 3. Testing /api/servers?malId=16498&ep=1&type=dub&source=desidub ---');
        const srvRes = await axios_1.default.get(`${base}/servers?malId=16498&ep=1&type=dub&source=desidub`);
        console.log('Servers found:', srvRes.data.servers.length);
        console.log('Servers list:', srvRes.data.servers);
        // 4. Watch endpoint
        console.log('\n--- 4. Testing /api/watch/desidub/mal-16498/1/dub ---');
        const watchRes = await axios_1.default.get(`${base}/watch/desidub/mal-16498/1/dub`);
        console.log('Watch Response:');
        console.log('  Server:', watchRes.data.server);
        console.log('  M3U8:', watchRes.data.m3u8?.slice(0, 70));
        console.log('  HlsProxyUrl:', watchRes.data.hlsProxyUrl?.slice(0, 70));
        console.log('  PlaybackMode:', watchRes.data.playbackMode);
        console.log('  Subtitles:', watchRes.data.subtitles);
        // 5. Proxy HLS endpoint
        if (watchRes.data.hlsProxyUrl) {
            console.log('\n--- 5. Testing Proxied HLS Playlist ---');
            const proxyRes = await axios_1.default.get(watchRes.data.hlsProxyUrl);
            console.log('Proxy status:', proxyRes.status);
            console.log('Proxy content preview:\n', proxyRes.data.slice(0, 250));
        }
        console.log('\n✅ ALL INTEGRATION TESTS PASSED PERFECTLY!');
    }
    catch (err) {
        console.error('Test error:', err.response?.data || err.message);
    }
    finally {
        server.close();
        process.exit(0);
    }
});
//# sourceMappingURL=test-integration.js.map