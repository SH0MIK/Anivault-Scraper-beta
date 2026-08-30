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
server.listen(4898, async () => {
    const base = 'http://127.0.0.1:4898/api';
    try {
        console.log('--- Testing All Servers for Attack on Titan S1 Ep 1 ---');
        const srvRes = await axios_1.default.get(`${base}/servers?malId=16498&ep=1&type=all&source=desidub`);
        const servers = srvRes.data.servers;
        console.log(`Found ${servers.length} servers:\n`);
        for (const s of servers) {
            try {
                const watchRes = await axios_1.default.get(`${base}/watch/desidub/16498/1/dub?server=${encodeURIComponent(s.name)}&strict=1`);
                console.log(`[${s.name}]`);
                console.log(`  Mode: ${watchRes.data.playbackMode}`);
                console.log(`  M3U8: ${watchRes.data.m3u8 ? watchRes.data.m3u8.slice(0, 65) + '...' : 'none (iframe)'}`);
                console.log(`  HLS Proxy: ${watchRes.data.hlsProxyUrl ? watchRes.data.hlsProxyUrl.slice(0, 65) + '...' : 'none'}`);
                console.log(`  Subtitles: ${watchRes.data.subtitles?.length || 0} tracks\n`);
            }
            catch (e) {
                console.log(`[${s.name}] Error: ${e.response?.data?.error || e.message}\n`);
            }
        }
    }
    catch (err) {
        console.error('Error:', err.response?.data || err.message);
    }
    finally {
        server.close();
        process.exit(0);
    }
});
//# sourceMappingURL=test-all-servers.js.map