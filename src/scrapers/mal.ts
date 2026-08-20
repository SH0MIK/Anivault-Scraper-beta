import * as cheerio from 'cheerio';
import { makeClient } from '../utils/fetch';
import { cacheGet, cacheSet } from '../utils/cache';

// ══════════════════════════════════════════════════════════════
// MYANIMELIST.NET — direct scrape, replacing Jikan
//   /anime/{id}   → anime details page (sidebar fields + schema.org tags)
//
// MAL is NOT behind Cloudflare (unlike Senshi), so no FlareSolverr needed.
// It IS strict about scrape rate — a single misbehaving client gets 429'd
// or IP-banned fast. Every request goes through `malQueue` below, which
// serializes requests with a fixed delay between them (concurrency 1).
// This matters because it's an in-memory queue: it only rate-limits
// correctly as long as this stays a single long-running process (Railway),
// not multiple stateless serverless invocations.
// ══════════════════════════════════════════════════════════════

const BASE = 'https://myanimelist.net';
const http = makeClient(BASE, BASE + '/');

// ── Rate-limit queue ─────────────────────────────────────────────────────
// FIFO, concurrency 1, fixed delay between dequeues. Deliberately simple —
// no external dep — since all we need is "never more than one MAL request
// in flight, and space them out."
class RateLimitQueue {
  private queue: Array<() => Promise<void>> = [];
  private running = false;

  constructor(private delayMs: number) {}

  add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await task());
        } catch (e) {
          reject(e);
        }
      });
      this.process();
    });
  }

  private async process() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const task = this.queue.shift()!;
      await task();
      if (this.queue.length) await new Promise((r) => setTimeout(r, this.delayMs));
    }
    this.running = false;
  }
}

const malQueue = new RateLimitQueue(parseInt(process.env.MAL_SCRAPE_DELAY_MS || '700'));

export interface MalAnimeDetails {
  malId: number;
  title: string;
  titleEnglish: string | null;
  titleJapanese: string | null;
  synopsis: string | null;
  image: string | null;
  type: string | null;
  episodes: number | null;
  status: string | null;
  aired: string | null;
  premiered: string | null;
  duration: string | null;
  rating: string | null;
  score: number | null;
  scoredBy: number | null;
  rank: number | null;
  popularity: number | null;
  members: number | null;
  genres: string[];
  studios: string[];
  source: string | null;
}

// MAL's sidebar rows look like:
//   <div class="spaceit_pad"><span class="dark_text">Episodes:</span> 37</div>
// Multi-value rows (Genres, Studios) hold <a> tags instead of trailing text.
type Doc = ReturnType<typeof cheerio.load>;

function sidebarRow($: Doc, label: string) {
  let match: ReturnType<Doc> | null = null;
  $('.leftside .spaceit_pad, .leftside .spaceit').each((_, el) => {
    const dark = $(el).find('span.dark_text').first();
    if (dark.length && dark.text().trim().replace(/:$/, '').toLowerCase() === label.toLowerCase()) {
      match = $(el);
    }
  });
  return match;
}

function sidebarText($: Doc, label: string): string | null {
  const row = sidebarRow($, label);
  if (!row) return null;
  const clone = row.clone();
  clone.find('span.dark_text').remove();
  const text = clone.text().trim().replace(/^,\s*/, '');
  return text && text.toLowerCase() !== 'unknown' && text !== 'add some' ? text : null;
}

function sidebarLinks($: Doc, label: string): string[] {
  const row = sidebarRow($, label);
  if (!row) return [];
  const out: string[] = [];
  row.find('a').each((_, a) => {
    const t = $(a).text().trim();
    if (t) out.push(t);
  });
  return out;
}

async function scrapeAnimeDetails(malId: number): Promise<MalAnimeDetails | null> {
  const res = await http.get(`/anime/${malId}`);
  const $ = cheerio.load(res.data);

  const title =
    $('h1.title-name strong').first().text().trim() ||
    $('span[itemprop="name"]').first().text().trim();
  if (!title) return null; // no such anime / page shape changed

  const synopsisRaw = $('p[itemprop="description"]').first().text().trim();
  const synopsis = synopsisRaw ? synopsisRaw.replace(/\[Written by MAL Rewrite\]/i, '').trim() || null : null;

  const image =
    $('img[itemprop="image"]').first().attr('data-src') ||
    $('img[itemprop="image"]').first().attr('src') ||
    null;

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
  };
}

// Metadata barely changes day to day, so this reuses the existing 24h
// "mapping" cache bucket (see utils/cache.ts) rather than adding a new TTL
// tier just for this.
export async function getAnimeDetails(malId: number): Promise<MalAnimeDetails | null> {
  const cacheKey = `mal:anime:${malId}`;
  const cached = cacheGet<MalAnimeDetails>(cacheKey);
  if (cached) return cached;

  const result = await malQueue.add(() => scrapeAnimeDetails(malId));
  if (result) cacheSet(cacheKey, result, 'mapping');
  return result;
}
