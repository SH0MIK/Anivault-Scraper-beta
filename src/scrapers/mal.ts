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

  const image = fullSizeImage(
    $('img[itemprop="image"]').first().attr('data-src') ||
      $('img[itemprop="image"]').first().attr('src') ||
      null
  );

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

// MAL serves list/grid thumbnails through a resizing path segment like
// /r/42x62/images/... -- stripping it returns the original full-size
// image instead of the small, blurry-when-scaled-up thumbnail.
function fullSizeImage(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/\/r\/\d+x\d+\//, '/');
}

function parseCharacterTables($: Doc): MalCharacter[] {
  // Merge by character ID rather than pushing one entry per table match.
  // MAL nests each character's voice-actor sub-list inside the same outer
  // <table> as the character's own info, and $('table') ends up matching
  // more than one level of that nesting for the same character -- so a
  // naive push produces duplicates, and searching the wrong (too-broad)
  // table for "role" can grab unrelated text. Merging keeps whichever
  // match has the best data for each field and unions voice actors,
  // instead of gambling on which table match "wins".
  const byId = new Map<number, MalCharacter>();

  $('table').each((_, table) => {
    const t = $(table);
    const charLink = t.find('a[href*="/character/"]').filter((__, el) => $(el).text().trim().length > 0).first();
    if (!charLink.length) return; // not a character block

    const charUrl = charLink.attr('href') || null;
    const id = idFromUrl(charUrl);
    const name = charLink.text().trim();
    if (id === null || !name) return;

    const charImg = fullSizeImage(
      t.find('img[src*="/characters/"], img[data-src*="/characters/"]').first().attr('data-src') ||
        t.find('img[src*="/characters/"], img[data-src*="/characters/"]').first().attr('src') ||
        null
    );

    // "Main"/"Supporting" sits as trailing text in the name link's own
    // cell (alongside a favorites count on this listing) -- scope to that
    // cell specifically rather than searching the whole matched table,
    // which can be a large wrapper spanning unrelated text.
    const nameCell = charLink.closest('td');
    let role = nameCell.text().replace(name, '').replace(/[\d,]+\s*Favorites/i, '').trim() || null;
    if (role && role.length > 20) role = null; // sanity guard against an oversized/wrong match

    const voiceActors: MalVoiceActor[] = [];
    t.find('a[href*="/people/"]').each((__, a) => {
      const vaName = $(a).text().trim();
      if (!vaName) return;
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
    if (!existing.role && role) existing.role = role;
    if (!existing.image && charImg) existing.image = charImg;
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
  note: string | null;
  spoilers: string[];
  favorites: number | null;
  image: string | null;
  animeography: MalCharacterAnime[];
  voiceActors: MalCharacterVA[];
}

// Animeography and Voice Actors are each rendered as ONE SEPARATE <table>
// per entry (not one table with many rows) -- same convention MAL uses on
// the anime-page character list. Classify every table on the page by
// which kind of link it contains rather than hunting for a section header,
// since the header tag/class for these sections isn't confirmed.
function parseLinkedTable($: Doc, table: ReturnType<Doc>, hrefContains: string) {
  const link = table.find(`a[href*="${hrefContains}"]`).filter((__, a) => $(a).text().trim().length > 0).first();
  if (!link.length) return null;
  const name = link.text().trim();
  if (!name) return null;
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

async function scrapeCharacterDetails(characterId: number): Promise<MalCharacterDetails | null> {
  const res = await http.get(`/character/${characterId}/_`);
  const $ = cheerio.load(res.data);

  const headerH2 = $('h2.normal_header').first();
  if (!headerH2.length) return null;

  const nameKanji = headerH2.find('small').first().text().trim().replace(/^\(|\)$/g, '') || null;
  const name = headerH2.clone().children('small').remove().end().text().trim();
  if (!name) return null;

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
  const spoilerSeen = new Set<string>();
  const spoilers: string[] = [];
  container.find('[class*="spoiler"]').each((_, el) => {
    const txt = $(el).text().trim();
    $(el).remove();
    if (!txt || txt.length < 15) return; // drops "Spoiler"/"Show"/"Hide"-style toggle labels
    if (spoilerSeen.has(txt)) return;
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
  if (nameKanji) about = about.replace(`(${nameKanji})`, '').replace(nameKanji, '').trim();
  // Strip leading "Label: value" quick-fact lines (Age:, Height:, etc. --
  // present for some characters, absent for others).
  about = about.replace(/^(?:\s*[A-Z][A-Za-z][A-Za-z ]{1,30}:\s*[^\n]*\n?)+/, '').trim();
  // Cut off before Voice Actors if that table's text leaked into this container.
  const voiceIdx = about.search(/Voice Actors/i);
  if (voiceIdx !== -1) about = about.slice(0, voiceIdx).trim();
  // MAL always appends a translation-credit footer ("Note: {Name} is the
  // official English translation by ...") at the end of the bio -- split
  // it into its own field rather than leaving it glued to the last
  // paragraph.
  let note: string | null = null;
  const noteMatch = about.match(/\n*Note:\s*([\s\S]*)$/i);
  if (noteMatch) {
    note = noteMatch[1].trim() || null;
    about = about.slice(0, noteMatch.index).trim();
  }
  if (!about) about = null;

  const animeography: MalCharacterAnime[] = [];
  const voiceActors: MalCharacterVA[] = [];
  const seenAnime = new Set<number | string>();
  const seenVA = new Set<number | string>();

  $('table').each((_, t) => {
    const table = $(t);
    const anime = parseLinkedTable($, table, '/anime/');
    if (anime) {
      const key = anime.id ?? anime.url ?? anime.name;
      if (seenAnime.has(key)) return; // MAL nests a table inside this table's cell, so $('table') matches both
      seenAnime.add(key);

      animeography.push({ animeId: anime.id, title: anime.name, url: anime.url, image: anime.image, role: anime.sub });
      return;
    }
    const va = parseLinkedTable($, table, '/people/');
    if (va) {
      const vaKey = va.id ?? va.url ?? va.name;
      if (seenVA.has(vaKey)) return;
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

export async function getCharacterDetails(characterId: number): Promise<MalCharacterDetails | null> {
  const cacheKey = `mal:character:${characterId}`;
  const cached = cacheGet<MalCharacterDetails>(cacheKey);
  if (cached) return cached;

  const result = await malQueue.add(() => scrapeCharacterDetails(characterId));
  if (result) cacheSet(cacheKey, result, 'mapping');
  return result;
}

// ══════════════════════════════════════════════════════════════
// Picture galleries — /anime/{id}/_/pics and /character/{id}/_/pics
//
// Same page structure for both, just a different URL prefix -- one shared
// parser. Each picture is a link (usually inside its own small table,
// matching MAL's convention everywhere else on the site) whose href points
// straight at the full-size CDN image; the <img> inside it is a smaller
// preview, kept as `thumbnail` after stripping MAL's resize-path segment
// (same fullSizeImage helper used elsewhere, applied here mainly in case
// the thumb src itself is occasionally the largest copy available).
// ══════════════════════════════════════════════════════════════

export interface MalPicture {
  image: string;
  thumbnail: string | null;
}

function parsePictures($: Doc): MalPicture[] {
  const seen = new Set<string>();
  const pics: MalPicture[] = [];

  $('a[href*="cdn.myanimelist.net"]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href || !/\.(jpe?g|png|webp)(\?|$)/i.test(href)) return; // skip non-image links MAL sometimes wraps in the same block
    if (seen.has(href)) return;
    seen.add(href);

    const thumbnail = fullSizeImage(
      $(a).find('img').first().attr('data-src') || $(a).find('img').first().attr('src') || null
    );

    pics.push({ image: href, thumbnail });
  });

  return pics;
}

async function scrapeAnimePictures(malId: number): Promise<MalPicture[]> {
  const res = await http.get(`/anime/${malId}/_/pics`);
  const $ = cheerio.load(res.data);
  return parsePictures($);
}

export async function getAnimePictures(malId: number): Promise<MalPicture[]> {
  const cacheKey = `mal:anime-pics:${malId}`;
  const cached = cacheGet<MalPicture[]>(cacheKey);
  if (cached) return cached;

  const result = await malQueue.add(() => scrapeAnimePictures(malId));
  cacheSet(cacheKey, result, 'mapping'); // gallery barely changes, reuse 24h bucket
  return result;
}

async function scrapeCharacterPictures(characterId: number): Promise<MalPicture[]> {
  const res = await http.get(`/character/${characterId}/_/pics`);
  const $ = cheerio.load(res.data);
  return parsePictures($);
}

export async function getCharacterPictures(characterId: number): Promise<MalPicture[]> {
  const cacheKey = `mal:character-pics:${characterId}`;
  const cached = cacheGet<MalPicture[]>(cacheKey);
  if (cached) return cached;

  const result = await malQueue.add(() => scrapeCharacterPictures(characterId));
  cacheSet(cacheKey, result, 'mapping');
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

function stripTags(html: string): string {
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
function extractBlock(html: string, startLabel: string, endLabels: string[], fromIndex = 0): string {
  const startIdx = html.indexOf(startLabel, fromIndex);
  if (startIdx === -1) return '';
  let endIdx = html.length;
  for (const label of endLabels) {
    const idx = html.indexOf(label, startIdx + startLabel.length);
    if (idx !== -1 && idx < endIdx) endIdx = idx;
  }
  return html.slice(startIdx, endIdx);
}

export interface MalTheme {
  number: number;
  title: string;
  artist: string;
  episodes: string | null;
  spotifyUrl: string | null;
}

function parseThemeBlock(text: string): MalTheme[] {
  const themes: MalTheme[] = [];
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
    if (!m) continue;
    i++;

    const title = m[2].trim();
    let rest = m[3];

    let episodes: string | null = null;
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
function extractSpotifyIds($: Doc): (string | null)[] {
  const ids: (string | null)[] = [];
  $('[onclick*="openMusicLinkPopup"], a[href*="openMusicLinkPopup"]').each((_, el) => {
    const raw = $(el).attr('onclick') || $(el).attr('href') || '';
    const m = raw.match(
      /openMusicLinkPopup\(\s*'[^']*'\s*,\s*'(?:[^'\\]|\\.)*'\s*,\s*'(?:[^'\\]|\\.)*'\s*,\s*'([^']*)'\s*\)/
    );
    ids.push(m ? m[1] : null);
  });
  return ids;
}

async function scrapeAnimeThemes(malId: number): Promise<{ opening: MalTheme[]; ending: MalTheme[] }> {
  const res = await http.get(`/anime/${malId}`);
  const html: string = res.data;

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

export async function getAnimeThemes(malId: number): Promise<{ opening: MalTheme[]; ending: MalTheme[] }> {
  const cacheKey = `mal:themes:${malId}`;
  const cached = cacheGet<{ opening: MalTheme[]; ending: MalTheme[] }>(cacheKey);
  if (cached) return cached;

  const result = await malQueue.add(() => scrapeAnimeThemes(malId));
  cacheSet(cacheKey, result, 'mapping'); // theme list never changes post-airing, reuse 24h bucket
  return result;
}

export interface MalVideo {
  label: string; // e.g. "PV 2", "ED 1 (Artist ver.)"
  youtubeId: string | null;
  embedUrl: string;
  songTitle: string | null; // music videos only
  songArtist: string | null; // music videos only
}

// Each music video's title/artist sits as plain quoted text right after
// its link ("Title" by Artist), not inside an anchor. Split into one
// chunk per quote+by occurrence first (same technique as theme parsing)
// rather than a single regex with a lookahead to guess where one entry's
// artist name ends and the next begins -- that approach broke the same
// way the theme parser's did, letting the next entry's label/"play" text
// bleed into the current artist field.
function parseMusicVideoSongs(text: string): { title: string; artist: string }[] {
  const songs: { title: string; artist: string }[] = [];
  const chunks = text.split(/(?="[^"]+"\s*by\s)/);
  for (const chunk of chunks) {
    const m = chunk.match(/^"([^"]+)"\s*by\s*([\s\S]*)$/);
    if (!m) continue;
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

function extractVideoLinks($: Doc): { label: string; youtubeId: string | null; embedUrl: string }[] {
  const out: { label: string; youtubeId: string | null; embedUrl: string }[] = [];
  $('a[href*="/embed/"]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href) return;
    const label = $(a).text().replace(/play\s*$/i, '').trim();
    const idMatch = href.match(/\/embed\/([a-zA-Z0-9_-]+)/);
    out.push({ label, youtubeId: idMatch ? idMatch[1] : null, embedUrl: href });
  });
  return out;
}

async function scrapeAnimeVideos(malId: number): Promise<{ musicVideos: MalVideo[]; trailers: MalVideo[] }> {
  const res = await http.get(`/anime/${malId}/_/video`);
  const html: string = res.data;

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
  const musicVideos: MalVideo[] = mvLinks.map((v, i) => ({
    ...v,
    songTitle: mvSongs[i]?.title ?? null,
    songArtist: mvSongs[i]?.artist ?? null,
  }));

  const tr$ = cheerio.load(trailerBlock);
  const trailers: MalVideo[] = extractVideoLinks(tr$).map((v) => ({ ...v, songTitle: null, songArtist: null }));

  return { musicVideos, trailers };
}

export async function getAnimeVideos(malId: number): Promise<{ musicVideos: MalVideo[]; trailers: MalVideo[] }> {
  const cacheKey = `mal:videos:${malId}`;
  const cached = cacheGet<{ musicVideos: MalVideo[]; trailers: MalVideo[] }>(cacheKey);
  if (cached) return cached;

  const result = await malQueue.add(() => scrapeAnimeVideos(malId));
  cacheSet(cacheKey, result, 'mapping');
  return result;
}
