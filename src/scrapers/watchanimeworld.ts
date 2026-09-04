import * as cheerio from 'cheerio';
import axios from 'axios';
import { cacheGet, cacheSet } from '../utils/cache';

const BASE = 'https://watchanimeworld.one';
const ZEPHYRIX = 'https://play.zephyrix.org';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: BASE + '/',
};

export interface WatchAnimeWorldSearchResult {
  slug: string;
  title: string;
  image?: string;
}

export interface WatchAnimeWorldEpisode {
  num: number;
  id: string;
  title: string;
}

export interface WatchAnimeWorldServer {
  name: string;
  sourceId: string;
  type: 'sub' | 'dub';
  lang?: string;
  audioTrack?: WatchAnimeWorldAudioTrack;
  qualities?: WatchAnimeWorldQuality[];
}

export interface WatchAnimeWorldSubtitle {
  lang: string;
  url: string;
  default?: boolean;
}

export interface WatchAnimeWorldAudioTrack {
  lang: string;
  name: string;
  url: string;
  default?: boolean;
}

export interface WatchAnimeWorldQuality {
  label: string;
  url: string;
  bandwidth?: number;
  resolution?: string;
}

export interface WatchAnimeWorldStream {
  embedUrl: string;
  m3u8: string | null;
  referer?: string;
  subtitles: WatchAnimeWorldSubtitle[];
  audioTracks?: WatchAnimeWorldAudioTrack[];
  qualities?: WatchAnimeWorldQuality[];
  selectedAudioLang?: string | null;
  serverName: string;
  type: 'hls' | 'iframe';
}

interface SeasonEpisode {
  season: number;
  episode: number;
  href: string;
  title: string;
}

function absoluteUrl(url: string): string {
  return new URL(url, BASE).toString();
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractSeasonHint(title: string): number | null {
  const normalized = title.replace(/\s+/g, ' ').trim();
  if (/\battack\s+on\s+titan\b/i.test(normalized) && /\bfinal\s+season\b/i.test(normalized)) return 4;
  const matches = [
    normalized.match(/\bseason\s*(\d+)\b/i),
    normalized.match(/\bs(\d+)\b/i),
    normalized.match(/\b(\d+)(?:st|nd|rd|th)\s+season\b/i),
  ];
  for (const match of matches) {
    const season = match?.[1] ? parseInt(match[1], 10) : NaN;
    if (Number.isFinite(season) && season > 0) return season;
  }
  return null;
}

function stripSeasonMarker(title: string): string {
  return title
    .replace(/\bfinal\s+season(?:\s+part\s+\d+)?\b/gi, '')
    .replace(/\bseason\s*\d+\b/gi, '')
    .replace(/\bs\d+\b/gi, '')
    .replace(/\b\d+(?:st|nd|rd|th)\s+season\b/gi, '')
    .replace(/\s*[-–—]\s*.*$/g, '')
    .replace(/\s*:\s*[^:]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[:|-]\s*$/g, '')
    .trim();
}

function extractEpisodeOffset(title: string): number {
  if (/\battack\s+on\s+titan\b/i.test(title) && /\bfinal\s+season\s+part\s*2\b/i.test(title)) return 16;
  return 0;
}

function encodeSourceId(slug: string, seasonHint?: number | null, episodeOffset = 0): string {
  if (!seasonHint || seasonHint <= 1) return slug;
  return `${slug}::s${seasonHint}${episodeOffset > 0 ? `o${episodeOffset}` : ''}`;
}

function decodeSourceId(sourceId: string): { slug: string; seasonHint: number | null; episodeOffset: number } {
  const match = sourceId.match(/^(.+?)::s(\d+)(?:o(\d+))?$/i);
  if (!match) return { slug: sourceId, seasonHint: null, episodeOffset: 0 };
  const seasonHint = parseInt(match[2], 10);
  const episodeOffset = match[3] ? parseInt(match[3], 10) : 0;
  return {
    slug: match[1],
    seasonHint: Number.isFinite(seasonHint) ? seasonHint : null,
    episodeOffset: Number.isFinite(episodeOffset) ? episodeOffset : 0,
  };
}

function withAudioSelection(embedUrl: string, lang?: string): string {
  if (!lang) return embedUrl;
  const url = new URL(embedUrl);
  url.hash = `waw-audio=${encodeURIComponent(lang)}`;
  return url.toString();
}

function extractAudioSelection(embedUrl: string): { cleanEmbedUrl: string; selectedLang: string | null } {
  const url = new URL(embedUrl);
  const selectedLang = url.hash.match(/waw-audio=([^&]+)/)?.[1];
  url.hash = '';
  return {
    cleanEmbedUrl: url.toString(),
    selectedLang: selectedLang ? decodeURIComponent(selectedLang).toLowerCase() : null,
  };
}

function scoreTitle(query: string, title: string): number {
  const needle = normalizeTitle(query);
  const hay = normalizeTitle(title);
  if (!needle || !hay) return 0;
  if (hay === needle) return 100;
  const ratio = Math.min(needle.length, hay.length) / Math.max(needle.length, hay.length);
  if (hay.startsWith(needle) || needle.startsWith(hay)) return Math.floor(ratio * 90);
  if (hay.includes(needle) || needle.includes(hay)) return Math.floor(ratio * 75);
  let matches = 0;
  for (const ch of needle) if (hay.includes(ch)) matches++;
  return Math.floor((matches / Math.max(needle.length, 1)) * 40);
}

function decodePacked(packed: string): string {
  const match = packed.match(/eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/);
  if (!match) return '';

  let [, payload, radixStr, countStr, dictStr] = match;
  const radix = parseInt(radixStr, 10);
  const count = parseInt(countStr, 10);
  const dict = dictStr.split('|');
  const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

  const toBase = (value: number): string => {
    let output = '';
    do {
      output = chars[value % radix] + output;
      value = Math.floor(value / radix);
    } while (value > 0);
    return output;
  };

  for (let i = count - 1; i >= 0; i--) {
    const key = toBase(i);
    const value = dict[i] || key;
    payload = payload.replace(new RegExp(`\\b${key}\\b`, 'g'), value);
  }
  return payload.replace(/\\'/g, "'");
}

function parseSeasonEpisode(href: string, fallback: number): { season: number; episode: number } {
  const path = new URL(href, BASE).pathname;
  const seasonEp = path.match(/-(\d+)x(\d+)\/?$/i);
  if (seasonEp) {
    return {
      season: parseInt(seasonEp[1], 10),
      episode: parseInt(seasonEp[2], 10),
    };
  }

  const ep = path.match(/(?:episode|ep)-?(\d+(?:\.\d+)?)/i);
  if (ep) return { season: 1, episode: parseFloat(ep[1]) };

  return { season: 1, episode: fallback };
}

async function getText(url: string, referer = BASE + '/'): Promise<string> {
  const res = await axios.get(url, {
    headers: { ...HEADERS, Referer: referer },
    timeout: 30000,
    responseType: 'text',
    transformResponse: [(data) => data],
  });
  return String(res.data);
}

async function getSeasonHtml(postId: string, season: number, referer: string): Promise<string> {
  const res = await axios.get(`${BASE}/wp-admin/admin-ajax.php`, {
    params: {
      action: 'action_select_season',
      season,
      post: postId,
    },
    headers: {
      ...HEADERS,
      Accept: 'text/html,*/*',
      Referer: referer,
      'X-Requested-With': 'XMLHttpRequest',
    },
    timeout: 30000,
    responseType: 'text',
    transformResponse: [(data) => data],
  });
  return String(res.data);
}

function parseSeasonEpisodes(html: string, fallbackSeason = 1): SeasonEpisode[] {
  const $ = cheerio.load(html);
  const episodes: SeasonEpisode[] = [];

  $('article.episodes, article').each((index, el) => {
    const $el = $(el);
    const href = $el.find('a[href*="/episode/"]').first().attr('href') || '';
    if (!href) return;

    const parsed = parseSeasonEpisode(href, index + 1);
    const season = Number.isFinite(parsed.season) ? parsed.season : fallbackSeason;
    const episode = Number.isFinite(parsed.episode) ? parsed.episode : index + 1;
    const title = $el.find('.entry-title, h2, h3').first().text().replace(/\s+/g, ' ').trim() || `S${season} Episode ${episode}`;

    episodes.push({
      season,
      episode,
      href: absoluteUrl(href),
      title,
    });
  });

  return Array.from(new Map(episodes.map((episode) => [episode.href, episode])).values());
}

export async function searchWatchAnimeWorld(query: string): Promise<WatchAnimeWorldSearchResult[]> {
  const cacheKey = `waw:search:${query.toLowerCase().trim()}`;
  const cached = cacheGet<WatchAnimeWorldSearchResult[]>(cacheKey);
  if (cached) return cached;

  const html = await getText(`${BASE}/?s=${encodeURIComponent(query)}`);
  const $ = cheerio.load(html);
  const results: WatchAnimeWorldSearchResult[] = [];

  $('article, .post-lst .post, .post').each((_, el) => {
    const $el = $(el);
    const title = $el.find('.entry-title, h2, h3').first().text().trim();
    const href = $el.find('a[href*="/series/"], a[href*="/movies/"], a[href]').first().attr('href') || '';
    const slug = href.match(/\/(?:series|movies)\/([^/]+)\/?/)?.[1] || '';
    if (!slug || !title) return;

    const image =
      $el.find('img').first().attr('data-src') ||
      $el.find('img').first().attr('src') ||
      undefined;

    if (!results.some((result) => result.slug === slug)) {
      results.push({ slug, title, image: image ? absoluteUrl(image) : undefined });
    }
  });

  cacheSet(cacheKey, results, 'episodes');
  return results;
}

export async function findWatchAnimeWorldSlug(title: string): Promise<string | null> {
  const seasonHint = extractSeasonHint(title);
  const episodeOffset = extractEpisodeOffset(title);
  const strippedTitle = stripSeasonMarker(title);
  const variants = Array.from(new Set([
    title,
    strippedTitle,
    title.replace(/['']/g, ''),
    strippedTitle.replace(/['']/g, ''),
    title.split(/[:(|-]/)[0]?.trim(),
    strippedTitle.split(/[:(|-]/)[0]?.trim(),
    strippedTitle.replace(/['']/g, '').split(/\s+/).slice(0, 2).join(' '),
    strippedTitle.replace(/['']/g, '').split(/\s+/).slice(0, 3).join(' '),
    title.replace(/['']/g, '').split(/\s+/).slice(0, 3).join(' '),
  ].filter((value): value is string => Boolean(value && value.trim().length >= 3))));

  const scoreQuery = strippedTitle || title;
  const allResults: WatchAnimeWorldSearchResult[] = [];
  for (const variant of variants) {
    const results = await searchWatchAnimeWorld(variant).catch(() => []);
    allResults.push(...results);
    if (results.some((result) => scoreTitle(scoreQuery, result.title) >= 80)) break;
  }

  const unique = Array.from(new Map(allResults.map((result) => [result.slug, result])).values());
  if (!unique.length) return null;

  const best = unique.map((result) => ({ result, score: scoreTitle(scoreQuery, result.title) })).sort((a, b) => b.score - a.score)[0];
  return best.score >= 55 ? encodeSourceId(best.result.slug, seasonHint, episodeOffset) : null;
}

export async function getWatchAnimeWorldEpisodes(sourceId: string): Promise<WatchAnimeWorldEpisode[]> {
  const cacheKey = `waw:episodes:${sourceId}`;
  const cached = cacheGet<WatchAnimeWorldEpisode[]>(cacheKey);
  if (cached) return cached;

  const { slug, seasonHint, episodeOffset } = decodeSourceId(sourceId);
  const seriesUrl = `${BASE}/series/${slug}/`;
  const html = await getText(seriesUrl);
  const $ = cheerio.load(html);
  const seasonLinks = $('.sel-temp a[data-season][data-post]')
    .map((_, el) => ({
      season: parseInt($(el).attr('data-season') || '', 10),
      postId: $(el).attr('data-post') || '',
    }))
    .get()
    .filter((item) => Number.isFinite(item.season) && item.postId);

  const bySeason = new Map<number, SeasonEpisode[]>();
  if (seasonLinks.length) {
    for (const item of seasonLinks.sort((a, b) => a.season - b.season)) {
      const seasonHtml = await getSeasonHtml(item.postId, item.season, seriesUrl).catch(() => '');
      const seasonEpisodes = parseSeasonEpisodes(seasonHtml || html, item.season).filter((episode) => episode.season === item.season);
      if (seasonEpisodes.length) bySeason.set(item.season, seasonEpisodes);
    }
  }

  if (bySeason.size === 0) {
    for (const episode of parseSeasonEpisodes(html)) {
      const list = bySeason.get(episode.season) || [];
      list.push(episode);
      bySeason.set(episode.season, list);
    }
  }

  if (seasonHint && bySeason.has(seasonHint)) {
    const seasonEpisodes = Array.from(new Map((bySeason.get(seasonHint) || []).map((episode) => [episode.href, episode])).values())
      .sort((a, b) => a.episode - b.episode)
      .filter((episode) => episode.episode > episodeOffset)
      .map((episode) => ({
        num: episode.episode - episodeOffset,
        id: episode.href,
        title: episode.title,
      }));
    if (seasonEpisodes.length) cacheSet(cacheKey, seasonEpisodes, 'episodes');
    return seasonEpisodes;
  }

  const episodes: WatchAnimeWorldEpisode[] = [];
  let offset = 0;
  for (const [season, seasonEpisodes] of [...bySeason.entries()].sort(([a], [b]) => a - b)) {
    const uniqueSeasonEpisodes = Array.from(new Map(seasonEpisodes.map((episode) => [episode.href, episode])).values())
      .sort((a, b) => a.episode - b.episode);
    for (const episode of uniqueSeasonEpisodes) {
      const num = offset + episode.episode;
      episodes.push({
        num,
        id: episode.href,
        title: season > 1 ? `S${season}E${episode.episode}: ${episode.title}` : episode.title,
      });
    }
    offset += uniqueSeasonEpisodes.length;
  }

  const unique = Array.from(new Map(episodes.map((episode) => [episode.num, episode])).values()).sort((a, b) => a.num - b.num);
  if (unique.length) cacheSet(cacheKey, unique, 'episodes');
  return unique;
}

export async function getWatchAnimeWorldServers(episodeUrl: string): Promise<WatchAnimeWorldServer[]> {
  const html = await getText(episodeUrl, `${BASE}/`);
  const $ = cheerio.load(html);
  const servers: WatchAnimeWorldServer[] = [];

  $('.video.aa-tb').each((_, el) => {
    const $el = $(el);
    const id = $el.attr('id') || '';
    const iframe = $el.find('iframe').first();
    const src = iframe.attr('src') || iframe.attr('data-src') || '';
    if (!src.includes('play.zephyrix.org')) return;

    const label = $(`a[href="#${id}"]`).text().replace(/\s+/g, ' ').trim();
    servers.push({
      name: label.replace(/^Server\s*\d+\s*/i, '').trim() || 'Play',
      sourceId: new URL(src, episodeUrl).toString(),
      type: 'dub',
    });
  });

  if (!servers.length) {
    $('iframe[src*="play.zephyrix.org"], iframe[data-src*="play.zephyrix.org"]').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (!src) return;
      servers.push({ name: 'Play', sourceId: new URL(src, episodeUrl).toString(), type: 'dub' });
    });
  }

  const baseServers = Array.from(new Map(servers.map((server) => [server.sourceId, {
    ...server,
    name: server.name.toLowerCase().includes('cloud') ? 'Play' : server.name,
  }])).values());

  const expanded: WatchAnimeWorldServer[] = [];
  for (const server of baseServers) {
    const stream = await getWatchAnimeWorldStream(server.sourceId).catch(() => null);
    if (!stream?.audioTracks?.length) {
      expanded.push(server);
      continue;
    }

    for (const track of stream.audioTracks) {
      const lang = track.lang.toLowerCase();
      expanded.push({
        name: track.name || lang,
        sourceId: withAudioSelection(server.sourceId, lang),
        type: lang === 'jpn' || lang === 'ja' || /japanese/i.test(track.name) ? 'sub' : 'dub',
        lang,
        audioTrack: track,
        qualities: stream.qualities || [],
      });
    }
  }

  return Array.from(new Map(expanded.map((server) => [`${server.type}:${server.name}:${server.sourceId}`, server])).values());
}

function extractZephyrixConfig(html: string): { id: string; title?: string; subtitles: WatchAnimeWorldSubtitle[] } | null {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  for (const script of scripts) {
    if (!script.includes('FirePlayer')) continue;
    const unpacked = decodePacked(script) || script;
    const id = unpacked.match(/FirePlayer\("([^"]+)"/)?.[1];
    const title = unpacked.match(/"title":"([^"]+)"/)?.[1]?.replace(/\\\//g, '/');
    const subtitles: WatchAnimeWorldSubtitle[] = [];
    const configJson = unpacked.match(/FirePlayer\("[^"]+"\s*,\s*(\{[\s\S]*?\})\s*\)/)?.[1];
    if (configJson) {
      try {
        const config = JSON.parse(configJson.replace(/\\\//g, '/'));
        for (const track of config?.tracks ?? []) {
          if (!track?.file || !['captions', 'subtitles'].includes(String(track.kind || '').toLowerCase())) continue;
          subtitles.push({
            url: new URL(String(track.file), ZEPHYRIX).toString(),
            lang: track.label || track.srclang || 'Subtitle',
            default: Boolean(track.default),
          });
        }
      } catch {
        // Fall through to the regex scan below.
      }
    }
    for (const match of unpacked.matchAll(/\{[^{}]*"file":"([^"]+)"[^{}]*"kind":"(captions|subtitles)"[^{}]*\}/gi)) {
      const raw = match[0];
      const label = raw.match(/"label":"([^"]+)"/i)?.[1] || raw.match(/"srclang":"([^"]+)"/i)?.[1] || 'Subtitle';
      const url = new URL(match[1].replace(/\\\//g, '/'), ZEPHYRIX).toString();
      if (!subtitles.some((sub) => sub.url === url)) subtitles.push({ url, lang: label });
    }
    if (id) return { id, title, subtitles };
  }
  return null;
}

function parseAttributes(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const payload = line.slice(line.indexOf(':') + 1);
  for (const match of payload.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi)) {
    attrs[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '');
  }
  return attrs;
}

function normalizeAudioName(attrs: Record<string, string>): { lang: string; name: string } {
  const rawLang = attrs.LANGUAGE || attrs.LANG || attrs.NAME || '';
  const rawName = attrs.NAME || rawLang || 'Audio';
  const languageNames: Record<string, string> = {
    jpn: 'Japanese',
    ja: 'Japanese',
    eng: 'English',
    en: 'English',
    hin: 'Hindi',
    hi: 'Hindi',
    tam: 'Tamil',
    ta: 'Tamil',
    tel: 'Telugu',
    te: 'Telugu',
    mal: 'Malayalam',
    ml: 'Malayalam',
    kan: 'Kannada',
    kn: 'Kannada',
  };
  const key = rawLang.toLowerCase();
  return {
    lang: key || rawName.toLowerCase(),
    name: languageNames[key] || rawName,
  };
}

function parseHlsMaster(master: string, masterUrl: string): { audioTracks: WatchAnimeWorldAudioTrack[]; qualities: WatchAnimeWorldQuality[]; subtitles: WatchAnimeWorldSubtitle[] } {
  const lines = master.split(/\r?\n/);
  const audioTracks: WatchAnimeWorldAudioTrack[] = [];
  const qualities: WatchAnimeWorldQuality[] = [];
  const subtitles: WatchAnimeWorldSubtitle[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/i.test(line)) {
      const attrs = parseAttributes(line);
      const uri = attrs.URI;
      if (!uri) continue;
      const named = normalizeAudioName(attrs);
      audioTracks.push({
        ...named,
        url: new URL(uri, masterUrl).toString(),
        default: attrs.DEFAULT?.toUpperCase() === 'YES',
      });
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA') && /TYPE=SUBTITLES/i.test(line)) {
      const attrs = parseAttributes(line);
      const uri = attrs.URI;
      if (!uri) continue;
      subtitles.push({
        lang: attrs.NAME || attrs.LANGUAGE || 'Subtitle',
        url: new URL(uri, masterUrl).toString(),
        default: attrs.DEFAULT?.toUpperCase() === 'YES',
      });
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const attrs = parseAttributes(line);
      const nextUri = lines.slice(i + 1).find((candidate) => {
        const trimmed = candidate.trim();
        return trimmed && !trimmed.startsWith('#');
      })?.trim();
      if (!nextUri) continue;
      const bandwidth = attrs.BANDWIDTH ? parseInt(attrs.BANDWIDTH, 10) : undefined;
      const resolution = attrs.RESOLUTION;
      const height = resolution?.match(/x(\d+)$/)?.[1];
      qualities.push({
        label: height ? `${height}p` : bandwidth ? `${Math.round(bandwidth / 1000)}kbps` : 'Auto',
        url: new URL(nextUri, masterUrl).toString(),
        bandwidth: Number.isFinite(bandwidth) ? bandwidth : undefined,
        resolution,
      });
    }
  }

  return {
    audioTracks: Array.from(new Map(audioTracks.map((track) => [`${track.lang}:${track.url}`, track])).values()),
    qualities: Array.from(new Map(qualities.map((quality) => [quality.url, quality])).values()),
    subtitles: Array.from(new Map(subtitles.map((subtitle) => [subtitle.url, subtitle])).values()),
  };
}

async function getHlsOptions(m3u8: string, referer: string): Promise<{ audioTracks: WatchAnimeWorldAudioTrack[]; qualities: WatchAnimeWorldQuality[]; subtitles: WatchAnimeWorldSubtitle[] }> {
  const res = await axios.get(m3u8, {
    headers: {
      'User-Agent': HEADERS['User-Agent'],
      Accept: '*/*',
      Referer: referer,
    },
    timeout: 30000,
    responseType: 'text',
    transformResponse: [(data) => data],
  });
  return parseHlsMaster(String(res.data), m3u8);
}

export async function getWatchAnimeWorldStream(embedUrl: string): Promise<WatchAnimeWorldStream | null> {
  const { cleanEmbedUrl, selectedLang } = extractAudioSelection(embedUrl);
  const embedHtml = await getText(cleanEmbedUrl, BASE + '/');
  const config = extractZephyrixConfig(embedHtml);
  const id = config?.id || new URL(cleanEmbedUrl).pathname.split('/').filter(Boolean).pop();
  if (!id) return null;

  const apiUrl = `${ZEPHYRIX}/player/index.php?data=${encodeURIComponent(id)}&do=getVideo`;
  const res = await axios.post(
    apiUrl,
    new URLSearchParams({ hash: id, r: BASE + '/' }).toString(),
    {
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        Accept: '*/*',
        Origin: ZEPHYRIX,
        Referer: `${ZEPHYRIX}/video/${id}`,
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      timeout: 30000,
    }
  );

  const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  const m3u8 = data?.securedLink || data?.videoSource || null;
  const referer = `${ZEPHYRIX}/video/${id}`;
  const hlsOptions = m3u8 ? await getHlsOptions(m3u8, referer).catch(() => ({ audioTracks: [], qualities: [], subtitles: [] })) : { audioTracks: [], qualities: [], subtitles: [] };
  const selectedTrack = selectedLang
    ? hlsOptions.audioTracks.find((track) => track.lang.toLowerCase() === selectedLang || track.name.toLowerCase() === selectedLang)
    : null;
  const audioTracks = selectedTrack ? [selectedTrack] : hlsOptions.audioTracks;
  const stream: WatchAnimeWorldStream = {
    embedUrl: cleanEmbedUrl,
    m3u8,
    referer,
    subtitles: [...(config?.subtitles || []), ...hlsOptions.subtitles],
    audioTracks,
    qualities: hlsOptions.qualities,
    selectedAudioLang: selectedTrack?.lang || null,
    serverName: selectedTrack?.name || 'Zephyrix',
    type: m3u8 ? 'hls' : 'iframe',
  };

  return stream;
}
