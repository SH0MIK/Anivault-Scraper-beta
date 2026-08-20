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

// ══════════════════════════════════════════════════════════════
// Episode list — /anime/{id}/_/episode
//
// MAL's routing keys off the numeric ID; the slug segment is cosmetic and
// tolerates a placeholder ("_"), so we skip resolving the real title slug.
// The page paginates 100 episodes at a time via ?offset=N. Shape mirrors
// Jikan's /anime/{id}/episodes response (mal_id, title, aired, filler,
// recap, pagination.has_next_page) so the PHP side is close to a drop-in
// swap.
// ══════════════════════════════════════════════════════════════

export interface MalEpisode {
  malId: number; // episode number, matching Jikan's mal_id field on episode objects
  url: string;
  title: string;
  titleJapanese: string | null;
  aired: string | null;
  filler: boolean;
  recap: boolean;
}

export interface MalEpisodePage {
  data: MalEpisode[];
  pagination: {
    currentPage: number;
    hasNextPage: boolean;
  };
}

const EPISODES_PER_PAGE = 100;

function parseEpisodeRows($: Doc, malId: number): MalEpisode[] {
  const episodes: MalEpisode[] = [];

  $('tr').each((_, tr) => {
    const row = $(tr);
    const numCell = row.find('td.episode-number');
    if (!numCell.length) return; // not an episode row (header/other tr)

    const num = parseInt(numCell.text().trim(), 10);
    if (isNaN(num)) return;

    const titleCell = row.find('td.episode-title');
    const link = titleCell.find('a').first();
    const title = link.text().trim();
    if (!title) return;

    const titleJapanese = titleCell.find('span').first().text().trim() || null;
    const aired = row.find('td.episode-aired').text().trim() || null;
    const cellText = titleCell.text().toLowerCase();

    const href = link.attr('href') || null;
    const url = href ? (href.startsWith('http') ? href : `${BASE}${href}`) : `${BASE}/anime/${malId}/_/episode/${num}`;

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

async function scrapeEpisodePage(malId: number, page: number): Promise<MalEpisodePage> {
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

export async function getEpisodes(malId: number, page = 1): Promise<MalEpisodePage> {
  const cacheKey = `mal:episodes:${malId}:${page}`;
  const cached = cacheGet<MalEpisodePage>(cacheKey);
  if (cached) return cached;

  const result = await malQueue.add(() => scrapeEpisodePage(malId, page));
  cacheSet(cacheKey, result, 'episodes');
  return result;
}

// Convenience: fetch every page and flatten, for callers that want the
// full episode list in one call instead of paging themselves.
export async function getAllEpisodes(malId: number): Promise<MalEpisode[]> {
  const all: MalEpisode[] = [];
  let page = 1;
  while (true) {
    const { data, pagination } = await getEpisodes(malId, page);
    all.push(...data);
    if (!pagination.hasNextPage) break;
    page++;
  }
  return all;
}

// ══════════════════════════════════════════════════════════════
// Characters + voice actors — /anime/{id}/_/characters
//
// Each character is a two-column table: left column is the character
// (photo, name, role), right column lists voice actors per language
// (photo, name, /people/{id} link). One request, no pagination — MAL
// shows the full cast on a single page regardless of length.
// ══════════════════════════════════════════════════════════════

export interface MalVoiceActor {
  peopleId: number | null;
  name: string;
  url: string | null;
  image: string | null;
  language: string | null;
}

export interface MalCharacter {
  characterId: number | null;
  name: string;
  url: string | null;
  image: string | null;
  role: string | null; // "Main" | "Supporting"
  voiceActors: MalVoiceActor[];
}

function idFromUrl(url: string | undefined | null): number | null {
  if (!url) return null;
  const m = url.match(/\/(\d+)\//);
  return m ? parseInt(m[1], 10) : null;
}

function parseCharacterTables($: Doc): MalCharacter[] {
  const characters: MalCharacter[] = [];

  $('table').each((_, table) => {
    const t = $(table);
    const charLink = t.find('a[href*="/character/"]').first();
    if (!charLink.length) return; // not a character block

    const charUrl = charLink.attr('href') || null;
    const charImg =
      t.find('img[src*="/characters/"], img[data-src*="/characters/"]').first().attr('data-src') ||
      t.find('img[src*="/characters/"], img[data-src*="/characters/"]').first().attr('src') ||
      null;

    // Name sits in a text link next to (or as) the character anchor.
    const nameLink = t.find('a[href*="/character/"]').filter((__, el) => $(el).text().trim().length > 0).first();
    const name = nameLink.text().trim();
    if (!name) return;

    const role = t.find('small').first().text().trim() || null;

    const voiceActors: MalVoiceActor[] = [];
    t.find('a[href*="/people/"]').each((__, a) => {
      const vaName = $(a).text().trim();
      if (!vaName) return;
      const vaUrl = $(a).attr('href') || null;
      // Language usually sits in a <small> right next to the VA link.
      const language = $(a).parent().find('small').first().text().trim() || null;
      const vaImg =
        $(a).parent().find('img').first().attr('data-src') ||
        $(a).parent().find('img').first().attr('src') ||
        null;

      voiceActors.push({
        peopleId: idFromUrl(vaUrl),
        name: vaName,
        url: vaUrl,
        image: vaImg,
        language,
      });
    });

    characters.push({
      characterId: idFromUrl(charUrl),
      name,
      url: charUrl,
      image: charImg,
      role,
      voiceActors,
    });
  });

  return characters;
}

async function scrapeCharacters(malId: number): Promise<MalCharacter[]> {
  const res = await http.get(`/anime/${malId}/_/characters`);
  const $ = cheerio.load(res.data);
  return parseCharacterTables($);
}

export async function getCharacters(malId: number): Promise<MalCharacter[]> {
  const cacheKey = `mal:characters:${malId}`;
  const cached = cacheGet<MalCharacter[]>(cacheKey);
  if (cached) return cached;

  const result = await malQueue.add(() => scrapeCharacters(malId));
  cacheSet(cacheKey, result, 'mapping'); // cast barely changes, reuse 24h bucket
  return result;
}
