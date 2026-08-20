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
  const seen = new Set<number>();

  $('tr').each((_, tr) => {
    const row = $(tr);
    const numCell = row.find('td.episode-number');
    if (!numCell.length) return; // not an episode row (header/other tr)

    // MAL renders a "Compact" view alongside the "Detailed" one, toggled
    // via CSS rather than left out of the DOM. It reuses the same
    // episode-number/episode-aired classes but as one row summarizing the
    // whole season, which .text() then concatenates into a single string
    // (e.g. "123456789101112" for a 12-episode show). A real episode
    // number is always short — reject anything that isn't.
    const rawNum = numCell.text().trim();
    if (!/^\d{1,4}$/.test(rawNum)) return;
    const num = parseInt(rawNum, 10);
    if (isNaN(num) || seen.has(num)) return;

    const titleCell = row.find('td.episode-title');
    const link = titleCell.find('a').first();
    const title = link.text().trim();
    if (!title) return;

    const titleJapanese = titleCell.find('span').first().text().trim() || null;
    let aired = row.find('td.episode-aired').text().trim() || null;
    // Same concatenation guard as the number check above, applied to aired.
    if (aired && aired.length > 40) aired = null;
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

// ══════════════════════════════════════════════════════════════
// Single character page — /character/{id}/_
//
// MAL puts bio, anime appearances, and voice actor roles all on ONE page
// (unlike Jikan, which splits these into 3 separate endpoint calls) --
// so this replaces 3 Jikan requests with 1 scrape.
//
// This is the shakiest of the scrapers so far: the anime/episode/character-
// list pages all have a fairly rigid table structure I had decent
// confidence in. This page's "About" bio text has no dedicated wrapper tag
// (unlike anime's itemprop="description"), so it's extracted by slicing
// the container's rendered text between "Member Favorites:" and
// "Animeography" rather than a clean selector -- most likely spot to need
// a live fix. Nicknames aren't extracted at all yet (left as []) since I
// don't have confident knowledge of where MAL places them on this page.
// ══════════════════════════════════════════════════════════════

export interface MalCharacterAnime {
  animeId: number | null;
  title: string;
  url: string | null;
  image: string | null;
  role: string | null;
}

export interface MalCharacterVA {
  peopleId: number | null;
  name: string;
  url: string | null;
  image: string | null;
  language: string | null;
}

export interface MalCharacterDetails {
  characterId: number;
  name: string;
  nameKanji: string | null;
  nicknames: string[];
  about: string | null;
  favorites: number | null;
  image: string | null;
  animeography: MalCharacterAnime[];
  voiceActors: MalCharacterVA[];
}

// Finds a section by its <h2>/<h3> header text (e.g. "Animeography") and
// returns the table that follows it.
function findSectionTable($: Doc, headerContains: string) {
  let table: ReturnType<Doc> | null = null;
  $('h2, h3').each((_, el) => {
    if ($(el).text().trim().toLowerCase().includes(headerContains.toLowerCase())) {
      const next = $(el).nextAll('table').first();
      if (next.length) table = next;
    }
  });
  return table;
}

// Shared row shape for both Animeography (/anime/ links) and Voice Actors
// (/people/ links) tables -- MAL renders both as poster-thumbnail + name +
// small-text-subtitle rows.
function parseLinkedRows($: Doc, table: ReturnType<Doc>, hrefContains: string) {
  const out: { id: number | null; name: string; url: string | null; image: string | null; sub: string | null }[] = [];
  table.find('tr').each((_, tr) => {
    const row = $(tr);
    const link = row.find(`a[href*="${hrefContains}"]`).filter((__, a) => $(a).text().trim().length > 0).first();
    if (!link.length) return;
    const name = link.text().trim();
    if (!name) return;
    const url = link.attr('href') || null;
    const image = row.find('img').first().attr('data-src') || row.find('img').first().attr('src') || null;
    const sub = row.find('small').first().text().trim() || null;
    out.push({ id: idFromUrl(url), name, url, image, sub });
  });
  return out;
}

async function scrapeCharacterDetails(characterId: number): Promise<MalCharacterDetails | null> {
  const res = await http.get(`/character/${characterId}/_`);
  const $ = cheerio.load(res.data);

  const headerH2 = $('h2.normal_header').first();
  if (!headerH2.length) return null;

  const nameKanji = headerH2.find('small').first().text().trim().replace(/^\(|\)$/g, '') || null;
  const name = headerH2.clone().children('small').remove().end().text().trim();
  if (!name) return null;

  const image =
    $('img[itemprop="image"]').first().attr('data-src') ||
    $('img[itemprop="image"]').first().attr('src') ||
    null;

  const bodyText = $('body').text();
  const favMatch = bodyText.match(/Member Favorites:\s*([\d,]+)/i);
  const favorites = favMatch ? parseInt(favMatch[1].replace(/,/g, ''), 10) : null;

  let about: string | null = null;
  const mainColText = headerH2.parent().text();
  const afterFav = mainColText.split(/Member Favorites:[\s\d,]*/i)[1];
  if (afterFav) {
    const beforeAnimeo = afterFav.split(/Animeography/i)[0].trim();
    about = beforeAnimeo || null;
  }

  const animeTable = findSectionTable($, 'Animeography');
  const animeography: MalCharacterAnime[] = animeTable
    ? parseLinkedRows($, animeTable, '/anime/').map((r) => ({
        animeId: r.id,
        title: r.name,
        url: r.url,
        image: r.image,
        role: r.sub,
      }))
    : [];

  const vaTable = findSectionTable($, 'Voice Actors');
  const voiceActors: MalCharacterVA[] = vaTable
    ? parseLinkedRows($, vaTable, '/people/').map((r) => ({
        peopleId: r.id,
        name: r.name,
        url: r.url,
        image: r.image,
        language: r.sub,
      }))
    : [];

  return {
    characterId,
    name,
    nameKanji,
    nicknames: [],
    about,
    favorites,
    image,
    animeography,
    voiceActors,
  };
}

export async function getCharacterDetails(characterId: number): Promise<MalCharacterDetails | null> {
  const cacheKey = `mal:character:${characterId}`;
  const cached = cacheGet<MalCharacterDetails>(cacheKey);
  if (cached) return cached;

  const result = await malQueue.add(() => scrapeCharacterDetails(characterId));
  if (result) cacheSet(cacheKey, result, 'mapping');
  return result;
}
