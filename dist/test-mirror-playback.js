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
server.listen(4897, async () => {
    const base = 'http://127.0.0.1:4897/api';
    try {
        console.log('--- 1. Testing Watch Endpoint for Mirrordub ---');
        const watchRes = await axios_1.default.get(`${base}/watch/desidub/16498/1/dub?server=Mirrordub&strict=1`);
        console.log('Server:', watchRes.data.server);
        console.log('Playback mode:', watchRes.data.playbackMode);
        console.log('Raw m3u8:', watchRes.data.m3u8);
        console.log('HLS Proxy URL:', watchRes.data.hlsProxyUrl);
        if (watchRes.data.hlsProxyUrl) {
            console.log('\n--- 2. Fetching Master Playlist from HLS Proxy ---');
            const masterRes = await axios_1.default.get(watchRes.data.hlsProxyUrl);
            console.log('Master Playlist:\n', masterRes.data);
            // Parse lines from master playlist
            const lines = masterRes.data.split('\n').map((l) => l.trim()).filter(Boolean);
            const subPlaylists = lines.filter((l) => l.startsWith('http'));
            console.log(`Found ${subPlaylists.length} sub-playlist / variant URLs`);
            // Check URI in directives
            const uriMatches = masterRes.data.match(/URI="([^"]+)"/g) || [];
            console.log('Directives with URI:', uriMatches);
            for (const uriStr of uriMatches) {
                const u = uriStr.replace(/URI="/, '').replace(/"$/, '');
                console.log(`\nTesting Directive URI: ${u}`);
                try {
                    const r = await axios_1.default.get(u);
                    console.log(`Status: ${r.status}, Preview:\n`, String(r.data).slice(0, 200));
                }
                catch (e) {
                    console.error(`FAILED Directive URI: ${e.message}`, e.response?.data || '');
                }
            }
            for (let i = 0; i < Math.min(subPlaylists.length, 3); i++) {
                const subUrl = subPlaylists[i];
                console.log(`\n--- Testing Sub-Playlist ${i + 1}: ${subUrl.slice(0, 80)}... ---`);
                try {
                    const subRes = await axios_1.default.get(subUrl);
                    console.log('Sub-playlist status:', subRes.status);
                    console.log('Sub-playlist snippet:\n', subRes.data.slice(0, 300));
                    // Test first segment
                    const segLines = subRes.data.split('\n').map((l) => l.trim()).filter(Boolean);
                    const segUrl = segLines.find((l) => l.startsWith('http'));
                    if (segUrl) {
                        console.log(`\nTesting Segment 1: ${segUrl.slice(0, 80)}...`);
                        const segRes = await axios_1.default.get(segUrl, { responseType: 'arraybuffer' });
                        console.log(`Segment status: ${segRes.status}, size: ${segRes.data.length} bytes`);
                    }
                }
                catch (e) {
                    console.error(`FAILED Sub-playlist: ${e.message}`, e.response?.data || '');
                }
            }
        }
        console.log('\n--- 3. Testing Watch Endpoint for Mirror (Muse)dub ---');
        const museRes = await axios_1.default.get(`${base}/watch/desidub/16498/1/dub?server=Mirror%20(Muse)dub&strict=1`);
        console.log('Server:', museRes.data.server);
        console.log('Playback mode:', museRes.data.playbackMode);
        console.log('Raw m3u8:', museRes.data.m3u8);
        console.log('HLS Proxy URL:', museRes.data.hlsProxyUrl);
        if (museRes.data.hlsProxyUrl) {
            console.log('\n--- 4. Fetching Master Playlist for Mirror (Muse)dub ---');
            const masterRes2 = await axios_1.default.get(museRes.data.hlsProxyUrl);
            console.log('Master Playlist:\n', masterRes2.data);
            const lines2 = masterRes2.data.split('\n').map((l) => l.trim()).filter(Boolean);
            const subPlaylists2 = lines2.filter((l) => l.startsWith('http'));
            const uriMatches2 = masterRes2.data.match(/URI="([^"]+)"/g) || [];
            console.log('Directives with URI:', uriMatches2);
            for (const uriStr of uriMatches2) {
                const u = uriStr.replace(/URI="/, '').replace(/"$/, '');
                console.log(`\nTesting Directive URI: ${u}`);
                try {
                    const r = await axios_1.default.get(u);
                    console.log(`Status: ${r.status}, Preview:\n`, String(r.data).slice(0, 200));
                }
                catch (e) {
                    console.error(`FAILED Directive URI: ${e.message}`, e.response?.data || '');
                }
            }
            for (let i = 0; i < Math.min(subPlaylists2.length, 2); i++) {
                const subUrl = subPlaylists2[i];
                console.log(`\n--- Testing Sub-Playlist: ${subUrl.slice(0, 80)}... ---`);
                try {
                    const subRes = await axios_1.default.get(subUrl);
                    console.log('Sub-playlist status:', subRes.status);
                    console.log('Sub-playlist snippet:\n', subRes.data.slice(0, 300));
                    const segLines = subRes.data.split('\n').map((l) => l.trim()).filter(Boolean);
                    const segUrl = segLines.find((l) => l.startsWith('http'));
                    if (segUrl) {
                        console.log(`Testing Segment 1: ${segUrl.slice(0, 80)}...`);
                        const segRes = await axios_1.default.get(segUrl, { responseType: 'arraybuffer' });
                        console.log(`Segment status: ${segRes.status}, size: ${segRes.data.length} bytes`);
                    }
                }
                catch (e) {
                    console.error(`FAILED Sub-playlist: ${e.message}`, e.response?.data || '');
                }
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
//# sourceMappingURL=test-mirror-playback.js.map