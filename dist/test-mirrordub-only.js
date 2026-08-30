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
server.listen(4896, async () => {
    const base = 'http://127.0.0.1:4896/api';
    try {
        console.log('--- 1. Testing Watch Endpoint for Mirrordub ---');
        const watchRes = await axios_1.default.get(`${base}/watch/desidub/16498/1/dub?server=Mirrordub&strict=1`);
        console.log('Server:', watchRes.data.server);
        console.log('Playback mode:', watchRes.data.playbackMode);
        console.log('Raw m3u8:', watchRes.data.m3u8);
        console.log('HLS Proxy URL:', watchRes.data.hlsProxyUrl);
        if (watchRes.data.hlsProxyUrl) {
            console.log('\n--- 2. Fetching Master Playlist from HLS Proxy ---');
            try {
                const masterRes = await axios_1.default.get(watchRes.data.hlsProxyUrl);
                console.log('Master Playlist snippet:\n', masterRes.data.slice(0, 400));
                // Parse first variant
                const lines = masterRes.data.split('\n').map((l) => l.trim()).filter(Boolean);
                const subPlaylists = lines.filter((l) => l.startsWith('http'));
                console.log('Sub-playlists count:', subPlaylists.length);
                if (subPlaylists.length > 0) {
                    console.log('Fetching sub-playlist 0:', subPlaylists[0]);
                    const subRes = await axios_1.default.get(subPlaylists[0]);
                    console.log('Sub-playlist status:', subRes.status);
                    console.log('Sub-playlist body snippet:\n', subRes.data.slice(0, 400));
                    const segLines = subRes.data.split('\n').map((l) => l.trim()).filter(Boolean);
                    const segUrl = segLines.find((l) => l.startsWith('http'));
                    if (segUrl) {
                        console.log('Fetching segment 0:', segUrl);
                        const segRes = await axios_1.default.get(segUrl, { responseType: 'arraybuffer' });
                        console.log('Segment status:', segRes.status, 'bytes:', segRes.data.length);
                    }
                }
            }
            catch (e) {
                console.error('Master Playlist error:', e.message, e.response?.status, e.response?.data);
            }
        }
    }
    catch (err) {
        console.error('Fatal error:', err.response?.data || err.message);
    }
    finally {
        server.close();
        process.exit(0);
    }
});
//# sourceMappingURL=test-mirrordub-only.js.map