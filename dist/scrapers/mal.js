"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAnimeDetails = getAnimeDetails;
exports.getStreamingPlatforms = getStreamingPlatforms;
exports.searchAnime = searchAnime;
exports.debugSearchHtml = debugSearchHtml;
exports.getEpisodes = getEpisodes;
exports.getAllEpisodes = getAllEpisodes;
exports.getEpisode = getEpisode;
exports.getCharacters = getCharacters;
exports.getCharacterDetails = getCharacterDetails;
exports.getAnimePictures = getAnimePictures;
exports.getCharacterPictures = getCharacterPictures;
exports.getAnimeThemes = getAnimeThemes;
exports.getAnimeVideos = getAnimeVideos;
exports.getExternalLinks = getExternalLinks;
exports.getRecommendations = getRecommendations;
const cheerio = __importStar(require("cheerio"));
const fetch_1 = require("../utils/fetch");
const cache_1 = require("../utils/cache");
// ══════════════════════════════════════════════════════════════
// MYANIMELIST.NET — direct scrape, replacing Jikan
//   /anime/{id}   → anime details page (sidebar fields + schema.org tags)
//
// MAL is NOT behind Cloudflare, so no FlareSolverr needed.
// It IS strict about scrape rate — a single misbehaving client gets 429'd
// or IP-banned fast. Every request goes through `malQueue` below, which
// serializes requests with a fixed delay between them (concurrency 1).
// This matters because it's an in-memory queue: it only rate-limits
// correctly as long as this stays a single long-running process (Railway),
// not multiple stateless serverless invocations.
// ══════════════════════════════════════════════════════════════
const BASE = 'https://myanimelist.net';
const http = (0, fetch_1.makeClient)(BASE, BASE + '/');
// ── Rate-limit queue ─────────────────────────────────────────────────────
// FIFO, concurrency 1, fixed delay between dequeues. Deliberately simple —
// no external dep — since all we need is "never more than one MAL request
// in flight, and space them out."
class RateLimitQueue {
    constructor(delayMs) {
        this.delayMs = delayMs;
        this.queue = [];
        this.running = false;
    }
    add(task) {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    resolve(await task());
                }
                catch (e) {
                    reject(e);
                }
            });
            this.process();
        });
    }
    async process() {
        if (this.running)
            return;
        this.running = true;
        while (this.queue.length) {
            const task = this.queue.shift();
            await task();
            if (this.queue.length)
                await new Promise((r) => setTimeout(r, this.delayMs));
        }
        this.running = false;
    }
}
const malQueue = new RateLimitQueue(parseInt(process.env.MAL_SCRAPE_DELAY_MS || '700'));
// MAL's "Streaming Platforms" sidebar block sits on the base /anime/{id}
// page, same page scrapeAnimeDetails() already fetches -- so this parses
// straight off that page's raw HTML instead of costing a second scrape.
// Confirmed live (Aug 2026): the block reads
//   Streaming Platforms [Crunchyroll](url "Crunchyroll") [Netflix](url "Netflix") ...
//   [More services](javascript:void(0);)May be unavailable in your region.
// "More services" reveals extra platforms client-side via JS but the
// anchors are already present in the raw HTML (just CSS-hidden), so this
// picks up the full list, not just the first few shown by default.
// Bounded the same way the video/recommendations sections below are --
// text-marker start/end rather than a guessed class name, since this
// sidebar block's own class hasn't been confirmed and MAL's boilerplate
// note ("May be unavailable...") or the "Characters & Staff" tab-nav link
// (which reliably follows every variant of this section, including a
// title with zero platforms) are far more stable anchors than markup.
function parseStreamingPlatforms(html) {
    const block = extractBlock(html, 'Streaming Platforms', [
        'May be unavailable in your region',
        'Characters &amp; Staff',
        'Characters & Staff',
    ]);
    if (!block)
        return [];
    const $$ = cheerio.load(block);
    const out = [];
    const seen = new Set();
    $$('a[href^="http"]').each((_, a) => {
        const href = $$(a).attr('href');
        if (!href || href.includes('myanimelist.net'))
            return; // "view on fandom" etc, not a streaming link
        if (seen.has(href))
            return;
        const name = $$(a).attr('title')?.trim() || $$(a).text().trim();
        if (!name)
            return;
        seen.add(href);
        out.push({ name, url: href });
    });
    return out;
}
function sidebarRow($, label) {
    let match = null;
    $('.leftside .spaceit_pad, .leftside .spaceit').each((_, el) => {
        const dark = $(el).find('span.dark_text').first();
        if (dark.length && dark.text().trim().replace(/:$/, '').toLowerCase() === label.toLowerCase()) {
            match = $(el);
        }
    });
    return match;
}
function sidebarText($, label) {
    const row = sidebarRow($, label);
    if (!row)
        return null;
    const clone = row.clone();
    clone.find('span.dark_text').remove();
    const text = clone.text().trim().replace(/^,\s*/, '');
    return text && text.toLowerCase() !== 'unknown' && text !== 'add some' ? text : null;
}
function sidebarLinks($, label) {
    const row = sidebarRow($, label);
    if (!row)
        return [];
    const out = [];
    row.find('a').each((_, a) => {
        const t = $(a).text().trim();
        if (t)
            out.push(t);
    });
    return out;
}
async function scrapeAnimeDetails(malId) {
    const res = await http.get(`/anime/${malId}`);
    const $ = cheerio.load(res.data);
    const title = $('h1.title-name strong').first().text().trim() ||
        $('span[itemprop="name"]').first().text().trim();
    if (!title)
        return null; // no such anime / page shape changed
    const synopsisRaw = $('p[itemprop="description"]').first().text().trim();
    const synopsis = synopsisRaw ? synopsisRaw.replace(/\[Written by MAL Rewrite\]/i, '').trim() || null : null;
    const image = fullSizeImage($('img[itemprop="image"]').first().attr('data-src') ||
        $('img[itemprop="image"]').first().attr('src') ||
        null);
    const scoreText = $('span[itemprop="ratingValue"]').first().text().trim();
    const score = scoreText && !isNaN(parseFloat(scoreText)) ? parseFloat(scoreText) : null;
    const scoredByText = $('span[itemprop="ratingCount"]').first().text().trim();
    const scoredBy = scoredByText ? parseInt(scoredByText.replace(/,/g, ''), 10) || null : null;
    const episodesText = sidebarText($, 'Episodes');
    const episodes = episodesText ? parseInt(episodesText, 10) || null : null;
    const rankText = sidebarText($, 'Rank');
    const rank = rankText ? parseInt(rankText.replace(/[#,]/g, ''), 10) || null : null;
    const popularityText = sidebarText($, 'Popularity');
    const popularity = popularityText ? parseInt(popularityText.replace(/[#,]/g, ''), 10) || null : null;
    const membersText = sidebarText($, 'Members');
    const members = membersText ? parseInt(membersText.replace(/,/g, ''), 10) || null : null;
    return {
        malId,
        title,
        titleEnglish: sidebarText($, 'English'),
        titleJapanese: sidebarText($, 'Japanese'),
        synopsis,
        image,
        type: sidebarText($, 'Type'),
        episodes,
        status: sidebarText($, 'Status'),
        aired: sidebarText($, 'Aired'),
        premiered: sidebarText($, 'Premiered'),
        duration: sidebarText($, 'Duration'),
        rating: sidebarText($, 'Rating'),
        score,
        scoredBy,
        rank,
        popularity,
        members,
        genres: sidebarLinks($, 'Genres'),
        studios: sidebarLinks($, 'Studios'),
        source: sidebarText($, 'Source'),
        streamingPlatforms: parseStreamingPlatforms(res.data),
    };
}
// Metadata barely changes day to day, so this reuses the existing 24h
// "mapping" cache bucket (see utils/cache.ts) rather than adding a new TTL
// tier just for this.
async function getAnimeDetails(malId) {
    const cacheKey = `mal:anime:${malId}`;
    const cached = (0, cache_1.cacheGet)(cacheKey);
    if (cached)
        return cached;
    const result = await malQueue.add(() => scrapeAnimeDetails(malId));
    if (result)
        (0, cache_1.cacheSet)(cacheKey, result, 'mapping');
    return result;
}
// Piggybacks on getAnimeDetails()'s cache -- streamingPlatforms is parsed
// off the same page fetch there, so this never costs an extra scrape/queue
// slot on its own. Mirrors Jikan's /anime/{id}/streaming response shape
// ({ data: [{ name, url }] }) at the route layer, matching the app's
// existing "scraper first, Jikan as fallback" convention for every other
// endpoint in this file.
async function getStreamingPlatforms(malId) {
    const details = await getAnimeDetails(malId);
    return details?.streamingPlatforms ?? [];
}
function parseSearchRows($) {
    const results = [];
    const seen = new Set();
    $('a.box-unit1-btn').each((_, a) => {
        const card = $(a);
        const href = card.attr('href');
        if (!href)
            return;
        const idMatch = href.match(/\/anime\/(\d+)\//);
        if (!idMatch)
            return;
        const malId = parseInt(idMatch[1], 10);
        if (seen.has(malId))
            return;
        const title = card.find('li.title').first().text().trim();
        if (!title)
            return;
        const img = card.find('img').first();
        const image = fullSizeImage(img.attr('data-src') || img.attr('src') || null);
        // Score sits as trailing text right after the "Score" label span inside
        // the same <li> -- strip the span's own text out and parse what's left.
        const scoreLi = card.find('li').filter((_, li) => $(li).find('span').first().text().trim() === 'Score').first();
        const scoreText = scoreLi.length ? scoreLi.clone().find('span').remove().end().text().trim() : '';
        const score = scoreText && !isNaN(parseFloat(scoreText)) ? parseFloat(scoreText) : null;
        // The type/episode line is a <dd> like "TV 500eps" / "Movie 1eps".
        const ddText = card.find('dd').first().text().trim();
        const ddMatch = ddText.match(/^(\S+)\s+(\d+)\s*eps?/i);
        seen.add(malId);
        results.push({
            malId,
            title,
            image,
            type: ddMatch ? ddMatch[1] : null,
            episodes: ddMatch ? parseInt(ddMatch[2], 10) : null,
            score,
            url: href.startsWith('http') ? href : `${BASE}${href}`,
        });
    });
    return results;
}
async function scrapeSearch(query, limit) {
    // Force MAL's mobile ("sp") layout for this request specifically — the
    // shared `http` client's default UA is desktop Chrome, which appears to
    // get served MAL's *different* desktop table layout on /anime.php
    // (unconfirmed shape, not handled here). The sp card layout
    // (div.box-unit1 > a.box-unit1-btn) parsed by parseSearchRows() below was
    // confirmed against a real live response, so pin this one call to a
    // mobile UA rather than guess at the desktop markup too.
    const res = await http.get('/anime.php', {
        params: { q: query, cat: 'anime' },
        headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        },
    });
    const $ = cheerio.load(res.data);
    return parseSearchRows($).slice(0, limit);
}
// Deliberately short TTL bucket (reuses 'stream' = 5min) — unlike anime
// metadata, search is query-keyed and low-value to hold onto for 24h; a
// typo'd or one-off query would otherwise squat in cache forever.
async function searchAnime(query, limit = 8) {
    const q = query.trim();
    if (!q)
        return [];
    const cacheKey = `mal:search:${q.toLowerCase()}:${limit}`;
    const cached = (0, cache_1.cacheGet)(cacheKey);
    if (cached)
        return cached;
    const result = await malQueue.add(() => scrapeSearch(q, limit));
    (0, cache_1.cacheSet)(cacheKey, result, 'stream');
    return result;
}
// Debug helper only -- returns what the search request actually got back
// (length + a snippet + whether the expected marker class is present) so a
// mismatch between "what a browser sees" and "what Railway's outbound
// request gets" can be diagnosed remotely without shell access to Railway.
async function debugSearchHtml(query) {
    const res = await http.get('/anime.php', {
        params: { q: query, cat: 'anime' },
        headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        },
        validateStatus: () => true,
    });
    const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    return {
        status: res.status,
        length: html.length,
        hasBoxUnit1: html.includes('box-unit1'),
        snippet: html.slice(0, 2000),
    };
}
const EPISODES_PER_PAGE = 100;
function parseEpisodeRows($, malId) {
    const episodes = [];
    const seen = new Set();
    $('tr').each((_, tr) => {
        const row = $(tr);
        const numCell = row.find('td.episode-number');
        if (!numCell.length)
            return; // not an episode row (header/other tr)
        const titleCell = row.find('td.episode-title');
        // MAL renders a "Compact" view alongside the "Detailed" one, toggled via
        // CSS rather than left out of the DOM. It's not one-row-per-episode like
        // the detailed view — it's a SINGLE row summarizing the whole season,
        // with every episode's number/title stacked as separate elements inside
        // that one row's cells. numCell.text() then concatenates all of them
        // into one string (e.g. "123456789101112" for a 12-episode show), and
        // titleCell has one <a> per episode instead of exactly one.
        //
        // The old guard only checked the concatenated number's *length*
        // (rejecting anything over 4 digits), which coincidentally still looks
        // like a plausible single episode number whenever a show has 4 or fewer
        // episodes aired so far — i.e. every currently-airing show during
        // roughly its first month. At that point titleCell.find('a').first()
        // silently grabs episode 1's title (the first stacked anchor), producing
        // a fake extra "episode" whose number is the concatenation of the real
        // ones and whose title is a duplicate of episode 1's — exactly what was
        // reported for a 4-episode-in show. Checking anchor count is a
        // structural signal that doesn't depend on how many episodes happen to
        // have aired, so it catches this at 1 aired episode just as reliably as
        // at 40.
        if (titleCell.find('a').length !== 1)
            return;
        const rawNum = numCell.text().trim();
        if (!/^\d{1,4}$/.test(rawNum))
            return; // still a useful backstop for longer-running shows
        const num = parseInt(rawNum, 10);
        if (isNaN(num) || seen.has(num))
            return;
        const link = titleCell.find('a').first();
        const title = link.text().trim();
        if (!title)
            return;
        const titleJapanese = titleCell.find('span').first().text().trim() || null;
        let aired = row.find('td.episode-aired').text().trim() || null;
        // Same concatenation guard as the number check above, applied to aired.
        if (aired && aired.length > 40)
            aired = null;
        const cellText = titleCell.text().toLowerCase();
        const href = link.attr('href') || null;
        const url = href ? (href.startsWith('http') ? href : `${BASE}${href}`) : `${BASE}/anime/${malId}/_/episode/${num}`;
        seen.add(num);
        episodes.push({
            malId: num,
            url,
            title,
            titleJapanese,
            aired,
            filler: cellText.includes('filler'),
            recap: cellText.includes('recap'),
        });
    });
    return episodes;
}
async function scrapeEpisodePage(malId, page) {
    const offset = (page - 1) * EPISODES_PER_PAGE;
    const res = await http.get(`/anime/${malId}/_/episode`, { params: offset ? { offset } : {} });
    const $ = cheerio.load(res.data);
    const data = parseEpisodeRows($, malId);
    return {
        data,
        pagination: {
            currentPage: page,
            hasNextPage: data.length === EPISODES_PER_PAGE,
        },
    };
}
async function getEpisodes(malId, page = 1) {
    const cacheKey = `mal:episodes:${malId}:${page}`;
    // Currently-airing shows gain a new episode row every week, so a cached
    // page (up to 1h stale) can undercount for as long as the TTL lives --
    // that's the "1174 vs 1175" bug. getAnimeDetails is already cached
    // (24h "mapping" bucket), so this status check is nearly free after the
    // first hit; only bypass the episode cache for shows still airing, and
    // let finished shows (the vast majority of lookups) keep the 1h cache.
    const details = await getAnimeDetails(malId).catch(() => null);
    const isAiring = details?.status === 'Currently Airing';
    if (!isAiring) {
        const cached = (0, cache_1.cacheGet)(cacheKey);
        if (cached)
            return cached;
    }
    const result = await malQueue.add(() => scrapeEpisodePage(malId, page));
    if (!isAiring)
        (0, cache_1.cacheSet)(cacheKey, result, 'episodes');
    return result;
}
// Convenience: fetch every page and flatten, for callers that want the
// full episode list in one call instead of paging themselves.
async function getAllEpisodes(malId) {
    const all = [];
    let page = 1;
    while (true) {
        const { data, pagination } = await getEpisodes(malId, page);
        all.push(...data);
        if (!pagination.hasNextPage)
            break;
        page++;
    }
    return all;
}
// Single-episode lookup, matching Jikan's /anime/{id}/episodes/{epNum}.
// MAL has no per-episode page of its own (episode numbers only exist as
// rows on the paginated list), so this just jumps straight to whichever
//100-episode page contains epNum and picks the matching row out of the
// already-cached getEpisodes() result -- no extra scrape cost for anime
// under 100 episodes, and only one extra page fetch beyond that.
async function getEpisode(malId, epNum) {
    if (epNum < 1)
        return null;
    const page = Math.floor((epNum - 1) / EPISODES_PER_PAGE) + 1;
    const { data } = await getEpisodes(malId, page);
    return data.find((e) => e.malId === epNum) ?? null;
}
function idFromUrl(url) {
    if (!url)
        return null;
    const m = url.match(/\/(\d+)\//);
    return m ? parseInt(m[1], 10) : null;
}
// MAL serves list/grid thumbnails through a resizing path segment like
// /r/42x62/images/... -- stripping it returns the original full-size
// image instead of the small, blurry-when-scaled-up thumbnail.
function fullSizeImage(url) {
    if (!url)
        return null;
    return url.replace(/\/r\/\d+x\d+\//, '/');
}
function parseCharacterTables($) {
    // Merge by character ID rather than pushing one entry per table match.
    // MAL nests each character's voice-actor sub-list inside the same outer
    // <table> as the character's own info, and $('table') ends up matching
    // more than one level of that nesting for the same character -- so a
    // naive push produces duplicates, and searching the wrong (too-broad)
    // table for "role" can grab unrelated text. Merging keeps whichever
    // match has the best data for each field and unions voice actors,
    // instead of gambling on which table match "wins".
    const byId = new Map();
    $('table').each((_, table) => {
        const t = $(table);
        const charLink = t.find('a[href*="/character/"]').filter((__, el) => $(el).text().trim().length > 0).first();
        if (!charLink.length)
            return; // not a character block
        const charUrl = charLink.attr('href') || null;
        const id = idFromUrl(charUrl);
        const name = charLink.text().trim();
        if (id === null || !name)
            return;
        const charImg = fullSizeImage(t.find('img[src*="/characters/"], img[data-src*="/characters/"]').first().attr('data-src') ||
            t.find('img[src*="/characters/"], img[data-src*="/characters/"]').first().attr('src') ||
            null);
        // "Main"/"Supporting" sits as trailing text in the name link's own
        // cell (alongside a favorites count on this listing) -- scope to that
        // cell specifically rather than searching the whole matched table,
        // which can be a large wrapper spanning unrelated text.
        const nameCell = charLink.closest('td');
        let role = nameCell.text().replace(name, '').replace(/[\d,]+\s*Favorites/i, '').trim() || null;
        if (role && role.length > 20)
            role = null; // sanity guard against an oversized/wrong match
        const voiceActors = [];
        t.find('a[href*="/people/"]').each((__, a) => {
            const vaName = $(a).text().trim();
            if (!vaName)
                return;
            const vaUrl = $(a).attr('href') || null;
            const vaCell = $(a).closest('td');
            const language = vaCell.text().replace(vaName, '').trim() || null;
            const vaImg = fullSizeImage(vaCell.find('img').first().attr('data-src') || vaCell.find('img').first().attr('src') || null);
            voiceActors.push({
                peopleId: idFromUrl(vaUrl),
                name: vaName,
                url: vaUrl,
                image: vaImg,
                language,
            });
        });
        const existing = byId.get(id);
        if (!existing) {
            byId.set(id, { characterId: id, name, url: charUrl, image: charImg, role, voiceActors });
            return;
        }
        // Merge into the existing entry: fill in whichever fields this match
        // has that the earlier one didn't, and union voice actors by ID.
        if (!existing.role && role)
            existing.role = role;
        if (!existing.image && charImg)
            existing.image = charImg;
        const seenVa = new Set(existing.voiceActors.map((v) => v.peopleId ?? v.name));
        for (const va of voiceActors) {
            const key = va.peopleId ?? va.name;
            if (!seenVa.has(key)) {
                existing.voiceActors.push(va);
                seenVa.add(key);
            }
        }
    });
    return Array.from(byId.values());
}
async function scrapeCharacters(malId) {
    const res = await http.get(`/anime/${malId}/_/characters`);
    const $ = cheerio.load(res.data);
    return parseCharacterTables($);
}
async function getCharacters(malId) {
    const cacheKey = `mal:characters:${malId}`;
    const cached = (0, cache_1.cacheGet)(cacheKey);
    if (cached)
        return cached;
    const result = await malQueue.add(() => scrapeCharacters(malId));
    (0, cache_1.cacheSet)(cacheKey, result, 'mapping'); // cast barely changes, reuse 24h bucket
    return result;
}
// Animeography and Voice Actors are each rendered as ONE SEPARATE <table>
// per entry (not one table with many rows) -- same convention MAL uses on
// the anime-page character list. Classify every table on the page by
// which kind of link it contains rather than hunting for a section header,
// since the header tag/class for these sections isn't confirmed.
function parseLinkedTable($, table, hrefContains) {
    const link = table.find(`a[href*="${hrefContains}"]`).filter((__, a) => $(a).text().trim().length > 0).first();
    if (!link.length)
        return null;
    const name = link.text().trim();
    if (!name)
        return null;
    const url = link.attr('href') || null;
    const image = fullSizeImage(table.find('img').first().attr('data-src') || table.find('img').first().attr('src') || null);
    // The "role"/"language" label sits as trailing plain text in the same
    // cell as the name link (alongside an "add to list" link on the
    // animeography side) -- strip the name and that boilerplate out rather
    // than rely on a dedicated tag.
    const cellText = link.closest('td').text();
    const sub = cellText.replace(name, '').replace(/\badd\b/gi, '').trim() || null;
    return { id: idFromUrl(url), name, url, image, sub };
}
async function scrapeCharacterDetails(characterId) {
    const res = await http.get(`/character/${characterId}/_`);
    const $ = cheerio.load(res.data);
    const headerH2 = $('h2.normal_header').first();
    if (!headerH2.length)
        return null;
    const nameKanji = headerH2.find('small').first().text().trim().replace(/^\(|\)$/g, '') || null;
    const name = headerH2.clone().children('small').remove().end().text().trim();
    if (!name)
        return null;
    // Character portraits aren't marked with itemprop="image" the way anime
    // posters are -- og:image is a reliable standard tag instead.
    const image = $('meta[property="og:image"]').attr('content') || null;
    const bodyText = $('body').text();
    const favMatch = bodyText.match(/Member Favorites:\s*([\d,]+)/i);
    const favorites = favMatch ? parseInt(favMatch[1].replace(/,/g, ''), 10) : null;
    // Bio text sits in the main column, after the h2 name and a block of
    // quick-fact lines (Age:, Height:, Birthdate:, etc. -- present for some
    // characters, absent for others), and before the "Voice Actors" section.
    // "Member Favorites"/"Animeography" live in the sidebar, not near the
    // bio, so they're not useful anchors here.
    const container = headerH2.parent();
    container.find('br').each((_, br) => {
        $(br).replaceWith('\n');
    });
    // MAL wraps spoiler bio text (character deaths, twists, etc.) in an
    // element that's only CSS-hidden (display:none) behind a "Click to Show
    // Spoiler" toggle -- the text itself is still in the DOM and still shows
    // up in .text(), just with no indication it was meant to be hidden.
    // Pull it out into its own field instead of leaving it inline. The
    // toggle's own label ("Spoiler"/"Show"/"Hide") apparently sits in a
    // separate element sharing the same class prefix, and the real content
    // sometimes gets matched twice (same duplication pattern as the
    // episode/animeography tables) -- filter label-only matches and dedupe.
    const spoilerSeen = new Set();
    const spoilers = [];
    container.find('[class*="spoiler"]').each((_, el) => {
        const txt = $(el).text().trim();
        $(el).remove();
        if (!txt || txt.length < 15)
            return; // drops "Spoiler"/"Show"/"Hide"-style toggle labels
        if (spoilerSeen.has(txt))
            return;
        spoilerSeen.add(txt);
        spoilers.push(txt);
    });
    let about = container.text();
    // MAL's page chrome ("Details / Clubs / Pictures" + the "Top > Characters
    // > {name}" breadcrumb) sits before the real content in this same
    // container. It always ends with the breadcrumb's own mention of
    // "Characters", so jump past that plus the blank-line run that follows
    // it rather than assuming real content starts at position 0.
    about = about.replace(/^[\s\S]*?\bCharacters\b[\s\S]*?\n\s*\n+/, '').trim();
    about = about.replace(name, '').trim();
    if (nameKanji)
        about = about.replace(`(${nameKanji})`, '').replace(nameKanji, '').trim();
    // Strip leading "Label: value" quick-fact lines (Age:, Height:, etc. --
    // present for some characters, absent for others).
    about = about.replace(/^(?:\s*[A-Z][A-Za-z][A-Za-z ]{1,30}:\s*[^\n]*\n?)+/, '').trim();
    // Cut off before Voice Actors if that table's text leaked into this container.
    const voiceIdx = about.search(/Voice Actors/i);
    if (voiceIdx !== -1)
        about = about.slice(0, voiceIdx).trim();
    // MAL always appends a translation-credit footer ("Note: {Name} is the
    // official English translation by ...") at the end of the bio -- split
    // it into its own field rather than leaving it glued to the last
    // paragraph.
    let note = null;
    const noteMatch = about.match(/\n*Note:\s*([\s\S]*)$/i);
    if (noteMatch) {
        note = noteMatch[1].trim() || null;
        about = about.slice(0, noteMatch.index).trim();
    }
    if (!about)
        about = null;
    const animeography = [];
    const voiceActors = [];
    const seenAnime = new Set();
    const seenVA = new Set();
    $('table').each((_, t) => {
        const table = $(t);
        const anime = parseLinkedTable($, table, '/anime/');
        if (anime) {
            const key = anime.id ?? anime.url ?? anime.name;
            if (seenAnime.has(key))
                return; // MAL nests a table inside this table's cell, so $('table') matches both
            seenAnime.add(key);
            animeography.push({ animeId: anime.id, title: anime.name, url: anime.url, image: anime.image, role: anime.sub });
            return;
        }
        const va = parseLinkedTable($, table, '/people/');
        if (va) {
            const vaKey = va.id ?? va.url ?? va.name;
            if (seenVA.has(vaKey))
                return;
            seenVA.add(vaKey);
            voiceActors.push({ peopleId: va.id, name: va.name, url: va.url, image: va.image, language: va.sub });
        }
    });
    return {
        characterId,
        name,
        nameKanji,
        nicknames: [],
        about,
        note,
        spoilers,
        favorites,
        image,
        animeography,
        voiceActors,
    };
}
async function getCharacterDetails(characterId) {
    const cacheKey = `mal:character:${characterId}`;
    const cached = (0, cache_1.cacheGet)(cacheKey);
    if (cached)
        return cached;
    const result = await malQueue.add(() => scrapeCharacterDetails(characterId));
    if (result)
        (0, cache_1.cacheSet)(cacheKey, result, 'mapping');
    return result;
}
function parsePictures($) {
    const seen = new Set();
    const pics = [];
    $('a[href*="cdn.myanimelist.net"]').each((_, a) => {
        const href = $(a).attr('href');
        if (!href || !/\.(jpe?g|png|webp)(\?|$)/i.test(href))
            return; // skip non-image links MAL sometimes wraps in the same block
        if (seen.has(href))
            return;
        seen.add(href);
        const thumbnail = fullSizeImage($(a).find('img').first().attr('data-src') || $(a).find('img').first().attr('src') || null);
        pics.push({ image: href, thumbnail });
    });
    return pics;
}
async function scrapeAnimePictures(malId) {
    const res = await http.get(`/anime/${malId}/_/pics`);
    const $ = cheerio.load(res.data);
    return parsePictures($);
}
async function getAnimePictures(malId) {
    const cacheKey = `mal:anime-pics:${malId}`;
    const cached = (0, cache_1.cacheGet)(cacheKey);
    if (cached)
        return cached;
    const result = await malQueue.add(() => scrapeAnimePictures(malId));
    (0, cache_1.cacheSet)(cacheKey, result, 'mapping'); // gallery barely changes, reuse 24h bucket
    return result;
}
async function scrapeCharacterPictures(characterId) {
    const res = await http.get(`/character/${characterId}/_/pics`);
    const $ = cheerio.load(res.data);
    return parsePictures($);
}
async function getCharacterPictures(characterId) {
    const cacheKey = `mal:character-pics:${characterId}`;
    const cached = (0, cache_1.cacheGet)(cacheKey);
    if (cached)
        return cached;
    const result = await malQueue.add(() => scrapeCharacterPictures(characterId));
    (0, cache_1.cacheSet)(cacheKey, result, 'mapping');
    return result;
}
// ══════════════════════════════════════════════════════════════
// Theme songs (Opening/Ending credits) and videos (music videos + PVs)
//
// MAL splits this across two different pages, so this mirrors that split
// rather than merging it into one call:
//   - Theme song CREDITS (title, artist, which episodes it covers) live on
//     the main /anime/{id} page as plain visible text: `1: "Title" by
//     Artist (eps 1-13)`. Every theme song is listed here even if MAL has
//     no embeddable video for it.
//   - Embeddable VIDEOS (YouTube IDs) for music videos and promotional
//     videos (PVs/trailers) live on the separate /anime/{id}/_/video page.
//     Not every theme song has one.
//
// Both extractions use text-slicing between landmark strings rather than
// selectors, same approach as the character bio extraction -- MAL doesn't
// wrap these sections in anything with a stable class name I could find,
// and the visible text itself is a reliable, consistently-formatted
// anchor ("Opening Theme" / "Ending Theme" / "Music Videos" / "Trailers"
// always appear verbatim as section labels).
// ══════════════════════════════════════════════════════════════
function stripTags(html) {
    return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}
// Slices out the substring starting at startLabel up to whichever of
// endLabels appears first after it (or end of string if none do).
function extractBlock(html, startLabel, endLabels, fromIndex = 0) {
    const startIdx = html.indexOf(startLabel, fromIndex);
    if (startIdx === -1)
        return '';
    let endIdx = html.length;
    for (const label of endLabels) {
        const idx = html.indexOf(label, startIdx + startLabel.length);
        if (idx !== -1 && idx < endIdx)
            endIdx = idx;
    }
    return html.slice(startIdx, endIdx);
}
function parseThemeBlock(text) {
    const themes = [];
    // Split into one chunk per entry using the "N: " marker (confirmed real
    // via a live screenshot) as the delimiter, then parse each chunk in
    // isolation. This replaces an earlier single-regex-with-lookahead
    // approach that had to guess where one entry ended and the next began --
    // fragile whenever unexpected text (an "Edit" link, boilerplate) sits
    // near that boundary. Splitting first removes the need to guess at all.
    const chunks = text.split(/(?=\d+\s*:\s*")/);
    let i = 0;
    for (const chunk of chunks) {
        const m = chunk.match(/^(\d+)\s*:\s*"([^"]+)"\s*by\s*([\s\S]*)$/);
        if (!m)
            continue;
        i++;
        const title = m[2].trim();
        let rest = m[3];
        let episodes = null;
        const epMatch = rest.match(/\(eps?\.?\s*([^)]+)\)/i);
        if (epMatch && epMatch.index !== undefined) {
            episodes = epMatch[1].trim();
            rest = rest.slice(0, epMatch.index); // only text before the eps parenthetical is the artist
        }
        // Strip trailing UI boilerplate ("Edit", "MV", "Preview") that
        // sometimes sits right after the artist name with no separator when
        // there's no eps parenthetical to anchor on instead.
        let artist = rest.replace(/\b(Edit|MV|Preview)\b[\s\S]*$/i, '').trim();
        artist = artist.replace(/[,\s]+$/, '').trim();
        themes.push({ number: m[1] ? parseInt(m[1], 10) : i, title, artist, episodes, spotifyUrl: null });
    }
    return themes;
}
// The "Preview" popup's Spotify/Apple/Amazon/YouTube Music buttons are
// populated by MAL's own JS when tapped -- only Spotify's ID is actually
// embedded in the page already, as the 4th argument to the onclick
// handler (a 22-char Spotify track ID). The other three platforms are
// resolved by a separate call this scraper has no visibility into, so
// only Spotify can be added this way.
function extractSpotifyIds($) {
    const ids = [];
    $('[onclick*="openMusicLinkPopup"], a[href*="openMusicLinkPopup"]').each((_, el) => {
        const raw = $(el).attr('onclick') || $(el).attr('href') || '';
        const m = raw.match(/openMusicLinkPopup\(\s*'[^']*'\s*,\s*'(?:[^'\\]|\\.)*'\s*,\s*'(?:[^'\\]|\\.)*'\s*,\s*'([^']*)'\s*\)/);
        ids.push(m ? m[1] : null);
    });
    return ids;
}
async function scrapeAnimeThemes(malId) {
    const res = await http.get(`/anime/${malId}`);
    const html = res.data;
    const openingBlock = extractBlock(html, 'Opening Theme', ['Ending Theme', 'More Videos', 'Episode Videos']);
    const endingBlock = extractBlock(html, 'Ending Theme', ['More Videos', 'Episode Videos']);
    const opening = parseThemeBlock(stripTags(openingBlock));
    const ending = parseThemeBlock(stripTags(endingBlock));
    // Spotify IDs are zipped in by position (same approach as music-video
    // song titles) since there's no direct DOM link between the flattened
    // text used above and these onclick attributes.
    const openingIds = extractSpotifyIds(cheerio.load(openingBlock));
    const endingIds = extractSpotifyIds(cheerio.load(endingBlock));
    opening.forEach((t, idx) => {
        t.spotifyUrl = openingIds[idx] ? `https://open.spotify.com/track/${openingIds[idx]}` : null;
    });
    ending.forEach((t, idx) => {
        t.spotifyUrl = endingIds[idx] ? `https://open.spotify.com/track/${endingIds[idx]}` : null;
    });
    return { opening, ending };
}
async function getAnimeThemes(malId) {
    const cacheKey = `mal:themes:${malId}`;
    const cached = (0, cache_1.cacheGet)(cacheKey);
    if (cached)
        return cached;
    const result = await malQueue.add(() => scrapeAnimeThemes(malId));
    (0, cache_1.cacheSet)(cacheKey, result, 'mapping'); // theme list never changes post-airing, reuse 24h bucket
    return result;
}
// Each music video's title/artist sits as plain quoted text right after
// its link ("Title" by Artist), not inside an anchor. Split into one
// chunk per quote+by occurrence first (same technique as theme parsing)
// rather than a single regex with a lookahead to guess where one entry's
// artist name ends and the next begins -- that approach broke the same
// way the theme parser's did, letting the next entry's label/"play" text
// bleed into the current artist field.
function parseMusicVideoSongs(text) {
    const songs = [];
    const chunks = text.split(/(?="[^"]+"\s*by\s)/);
    for (const chunk of chunks) {
        const m = chunk.match(/^"([^"]+)"\s*by\s*([\s\S]*)$/);
        if (!m)
            continue;
        let artist = m[2];
        // Cut off at the next entry's video label (e.g. "ED 2 (Artist ver.)
        // play") or any leftover "play" boilerplate bleeding in from it.
        artist = artist.replace(/\b(?:ED|OP|PV)\s*\d+[\s\S]*$/i, '').trim();
        artist = artist.replace(/play[\s\S]*$/i, '').trim();
        artist = artist.replace(/[,\s]+$/, '').trim();
        songs.push({ title: m[1].trim(), artist });
    }
    return songs;
}
function extractVideoLinks($) {
    const out = [];
    $('a[href*="/embed/"]').each((_, a) => {
        const href = $(a).attr('href');
        if (!href)
            return;
        const label = $(a).text().replace(/play\s*$/i, '').trim();
        const idMatch = href.match(/\/embed\/([a-zA-Z0-9_-]+)/);
        out.push({ label, youtubeId: idMatch ? idMatch[1] : null, embedUrl: href });
    });
    return out;
}
async function scrapeAnimeVideos(malId) {
    const res = await http.get(`/anime/${malId}/_/video`);
    const html = res.data;
    const mvStartIdx = html.indexOf('Music Videos');
    const mvBlock = mvStartIdx === -1 ? '' : extractBlock(html, 'Music Videos', ['Add Promotional Video', 'Trailers']);
    // MAL's own global nav (present on every page) has a "Watch > Anime
    // Trailers" link near the very top -- a from-the-start search for
    // "Trailers" matches that first (it's a substring of "Anime Trailers"),
    // badly over-capturing everything from near the page top through the
    // real Trailers section, including all of Music Videos along the way.
    // Only search for it after the Music Videos block ends, since the nav
    // always sits above both real sections.
    const trailerSearchFrom = mvStartIdx === -1 ? 0 : mvStartIdx + mvBlock.length;
    const trailerStartIdx = html.indexOf('Trailers', trailerSearchFrom);
    const trailerBlock = trailerStartIdx === -1 ? '' : extractBlock(html, 'Trailers', ['Top Anime'], trailerStartIdx);
    const mv$ = cheerio.load(mvBlock);
    const mvLinks = extractVideoLinks(mv$);
    const mvSongs = parseMusicVideoSongs(stripTags(mvBlock));
    const musicVideos = mvLinks.map((v, i) => ({
        ...v,
        songTitle: mvSongs[i]?.title ?? null,
        songArtist: mvSongs[i]?.artist ?? null,
    }));
    const tr$ = cheerio.load(trailerBlock);
    const trailers = extractVideoLinks(tr$).map((v) => ({ ...v, songTitle: null, songArtist: null }));
    return { musicVideos, trailers };
}
async function getAnimeVideos(malId) {
    const cacheKey = `mal:videos:${malId}`;
    const cached = (0, cache_1.cacheGet)(cacheKey);
    if (cached)
        return cached;
    const result = await malQueue.add(() => scrapeAnimeVideos(malId));
    (0, cache_1.cacheSet)(cacheKey, result, 'mapping');
    return result;
}
// MAL's global site footer/nav (social links, app store badges, Google
// policy links, ad-partner links) sits on every single page and gets
// scraped up by the generic "any outbound anchor" approach above along
// with the actual anime-specific external links. None of it varies by
// anime ID, so it's pure noise for a caller filtering this list -- drop
// anything matching these known footer/nav domains.
const FOOTER_DOMAINS = [
    'facebook.com', 'x.com', 'instagram.com', 'discord.gg',
    'apps.apple.com', 'play.google.com', 'policies.google.com',
    'otakumode.com', 'honeyfeed.fm',
];
function parseExternalLinks($) {
    const out = [];
    const seen = new Set();
    $('a[href^="http"]').each((_, a) => {
        const href = $(a).attr('href');
        if (!href)
            return;
        if (href.includes('myanimelist.net'))
            return; // internal nav/social-share links
        if (FOOTER_DOMAINS.some((d) => href.includes(d)))
            return;
        if (seen.has(href))
            return;
        const name = $(a).text().trim() || new URL(href).hostname.replace(/^www\./, '');
        seen.add(href);
        out.push({ name, url: href });
    });
    return out;
}
async function scrapeExternalLinks(malId) {
    const res = await http.get(`/anime/${malId}/_/external_links`);
    const $ = cheerio.load(res.data);
    return parseExternalLinks($);
}
async function getExternalLinks(malId) {
    const cacheKey = `mal:external:${malId}`;
    const cached = (0, cache_1.cacheGet)(cacheKey);
    if (cached)
        return cached;
    const result = await malQueue.add(() => scrapeExternalLinks(malId));
    (0, cache_1.cacheSet)(cacheKey, result, 'mapping');
    return result;
}
function scrapeRecommendationsHtml(html, currentAnimeId) {
    const recs = [];
    const seen = new Set();
    const chunks = html.split(/(?="Anime: )/);
    for (const chunk of chunks) {
        const titleMatch = chunk.match(/^"Anime:\s*([^"]+)"/);
        if (!titleMatch)
            continue;
        const title = titleMatch[1].trim();
        if (!title)
            continue;
        const idMatch = chunk.match(/\/anime\/(\d+)\//);
        const animeId = idMatch ? parseInt(idMatch[1], 10) : null;
        if (!animeId || animeId === currentAnimeId || seen.has(animeId))
            continue;
        seen.add(animeId);
        // Unbounded (searches the whole chunk). Bounding this turned out to be
        // more trouble than it was worth: a 500-char window found nothing, a
        // 4000-char window broke exactly the highest-voted entries (the ones
        // that matter most, since results are capped to the top N below), and
        // a "permalink"-bounded window broke everything. The only real failure
        // case for unbounded search was the very last entry in the full list
        // running off the end of the page into the footer -- which no longer
        // matters now that results are capped well before reaching it.
        const imgMatch = chunk.match(/(?:data-src|src)="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
        const image = imgMatch ? fullSizeImage(imgMatch[1]) : null;
        // Stop counting at the next block's own marker so its votes don't leak
        // into this one.
        const nextIdx = chunk.indexOf('"Anime: ', 1);
        const scoped = nextIdx === -1 ? chunk : chunk.slice(0, nextIdx);
        const votes = (scoped.match(/Recommended by/g) || []).length;
        recs.push({ animeId, title, image, votes });
    }
    return recs;
}
async function scrapeRecommendations(malId) {
    const res = await http.get(`/anime/${malId}/_/userrecs`);
    return scrapeRecommendationsHtml(res.data, malId);
}
const RECOMMENDATIONS_LIMIT = 12;
async function getRecommendations(malId) {
    const cacheKey = `mal:recommendations:${malId}`;
    const cached = (0, cache_1.cacheGet)(cacheKey);
    if (cached)
        return cached;
    const full = await malQueue.add(() => scrapeRecommendations(malId));
    // Already vote-sorted (highest first) since that's MAL's own list order --
    // no site UI built on this needs more than a handful for a carousel.
    const result = full.slice(0, RECOMMENDATIONS_LIMIT);
    (0, cache_1.cacheSet)(cacheKey, result, 'mapping');
    return result;
}
//# sourceMappingURL=mal.js.map