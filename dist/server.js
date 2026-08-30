"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const path_1 = __importDefault(require("path"));
const routes_1 = __importDefault(require("./routes"));
const discord_relay_1 = __importDefault(require("./discord-relay"));
const image_migrator_1 = __importDefault(require("./image-migrator"));
const app = (0, express_1.default)();
const PORT = parseInt(process.env.PORT || '3000');
app.set('trust proxy', 1);
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// Rate limiting
const limiter = (0, express_rate_limit_1.default)({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
    max: parseInt(process.env.RATE_LIMIT_MAX || '60'),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down.' },
});
app.use('/api', limiter);
// API routes
app.use('/api', routes_1.default);
// Discord webhook relay (PHP → Railway → Vercel bot → Discord)
app.use('/discord', discord_relay_1.default);
// One-off InfinityFree → R2 image migration tool (FTP-based). Delete this
// line + src/image-migrator.ts once the migration is done.
app.use('/migrate-images', image_migrator_1.default);
// Serve static docs/tester
app.use(express_1.default.static(path_1.default.join(__dirname, '../public')));
// Catch-all → docs
app.get('*', (_req, res) => {
    res.sendFile(path_1.default.join(__dirname, '../public/index.html'));
});
app.listen(PORT, () => {
    console.log(`\n🟢 AniVault API running on http://localhost:${PORT}`);
    console.log(`📄 Docs + Tester: http://localhost:${PORT}/`);
    console.log(`🔗 API base:      http://localhost:${PORT}/api\n`);
    // Keep FlareSolverr alive on Render free tier (sleeps after 15min inactivity)
    const flaresolverrUrl = process.env.FLARESOLVERR_URL;
    if (flaresolverrUrl) {
        const ping = () => {
            fetch(flaresolverrUrl)
                .then(() => console.log('[pinger] FlareSolverr alive ✅'))
                .catch((e) => console.warn('[pinger] FlareSolverr ping failed:', e.message));
        };
        ping(); // ping immediately on startup
        setInterval(ping, 9 * 60 * 1000); // then every 9 minutes
        console.log(`🏓 FlareSolverr pinger active → ${flaresolverrUrl}`);
    }
});
exports.default = app;
//# sourceMappingURL=server.js.map