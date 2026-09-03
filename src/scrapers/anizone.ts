import { decodeEntities, fetchHtml, findBestSlug } from './_shared';
import { cacheGet, cacheSet } from '../utils/cache';

// ══════════════════════════════════════════════════════════════
// ANIZONE.TO — title-search + Alpine.js x-data JSON scraper
// (ported from Anivexa's anizone.js)
// ══════════════════════════════════════════════════════════════

const BASE = 'https://anizone.to';

export interface AnizoneEpisode {
  num: number;
  id: string; // `${slug}:${num}`
  title: string;
}

export interface AnizoneServer {
  name: string;
  sourceId: string; // `${slug}:${num}`
  type: 'sub';
}

export interface AnizoneEmbedResult {
  embedUrl: string;
  m3u8: string | null;
  referer?: string;
  subtitles: { url: string; label: string; lang: string; format: string; default: boolean }[];
}

function processJsonArg(raw: string): any {
  const PH = '\x01U\x01';
  let s = raw.replace(/\\\\u([0-9a-fA-F]{4})/g, `${PH}$1`);
  s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(new RegExp(`${PH}([0-9a-fA-F]{4})`, 'g'), '\\u$1');
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function pickTitle(titles: Record<string, string>): string {
  return titles['1'] || titles['5'] || titles['8'] || Object.values(titles)[0] || '';
}

function extractSlug(ctx: string): string | null {
  const m = ctx.match(/href="(?:https:\/\/anizone\.to)?\/anime\/([a-z0-9-]+)"/);
  return m ? m[1] : null;
}

function extractJsonArg(xdata: string, key: string): string | null {
  const re = new RegExp(`${key}:\\s*JSON\\.parse\\('((?:[^'\\\\]|\\\\.)*)'\\)`);
  const m = xdata.match(re);
  return m ? m[1] : null;
}

async function search(query: string): Promise<{ slug: string; text: string }[]> {
  const html = await fetchHtml(`${BASE}/anime?search=${encodeURIComponent(query)}`);
  const results: { slug: string; text: string }[] = [];
  const xdataRe = /x-data="(\{[^"]*anmTitles[^"]*\})"/g;
  let m;
  while ((m = xdataRe.exec(html)) !== null) {
    const ctxStart = Math.max(0, m.index - 300);
    const ctxEnd = Math.min(html.length, m.index + m[0].length + 800);
    const ctx = html.slice(ctxStart, ctxEnd);
    const slug = extractSlug(ctx);
    if (!slug) continue;
    const xdata = decodeEntities(m[1]);
    const raw = extractJsonArg(xdata, 'anmTitles');
    if (!raw) continue;
    const titles = processJsonArg(raw);
    const title = pickTitle(titles);
    if (title) results.push({ slug, text: title });
  }
  return results;
}

async function searchFn(query: string): Promise<{ slug: string; text: string }[]> {
  const r1 = await search(query);
  // AniZone needs a plain alphanumeric token to surface all season variants
  const compact = query.split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, '');
  if (compact.length >= 4 && compact.toLowerCase() !== query.toLowerCase()) {
    try {
      const r2 = await search(compact);
      const seen = new Set(r1.map((r) => r.slug));
      r2.forEach((r) => { if (!seen.has(r.slug)) r1.push(r); });
    } catch {
      // ignore
    }
  }
  return r1;
}

export async function findAnizoneSlug(title: string, altTitle?: string | null): Promise<string | null> {
  return findBestSlug('anizone:slug', title, altTitle, searchFn);
}

interface RawEpisode {
  number: number;
  title: string;
}

async function scrapeSeries(slug: string): Promise<RawEpisode[]> {
  const cacheKey = `anizone:eps:${slug}`;
  const cached = cacheGet<RawEpisode[]>(cacheKey);
  if (cached) return cached;

  const html = await fetchHtml(`${BASE}/anime/${slug}`);
  const episodes: RawEpisode[] = [];
  const xdataRe = /x-data="(\{[^"]*epsTitles[^"]*\})"/g;
  let m;
  while ((m = xdataRe.exec(html)) !== null) {
    const ctxStart = Math.max(0, m.index - 400);
    const ctxEnd = Math.min(html.length, m.index + m[0].length + 800);
    const ctx = html.slice(ctxStart, ctxEnd);
    const numMatch = ctx.match(/href="(?:https:\/\/anizone\.to)?\/anime\/[a-z0-9-]+\/(\d+)"/);
    if (!numMatch) continue;
    const num = Number(numMatch[1]);
    if (!Number.isFinite(num) || num < 1) continue;
    const xdata = decodeEntities(m[1]);
    const raw = extractJsonArg(xdata, 'epsTitles');
    let title = `Episode ${num}`;
    if (raw) {
      const titles = processJsonArg(raw);
      title = pickTitle(titles) || title;
    }
    episodes.push({ number: num, title });
  }
  const seen = new Set<number>();
  const unique = episodes.filter((e) => (seen.has(e.number) ? false : (seen.add(e.number), true))).sort((a, b) => a.number - b.number);
  if (unique.length) cacheSet(cacheKey, unique, 'episodes');
  return unique;
}

export async function getAnizoneEpisodes(slug: string): Promise<AnizoneEpisode[]> {
  const raw = await scrapeSeries(slug);
  return raw.map((ep) => ({ num: ep.number, id: `${slug}:${ep.number}`, title: ep.title }));
}

export async function getAnizoneServers(episodeId: string): Promise<AnizoneServer[]> {
  const [slug, numStr] = episodeId.split(':');
  if (!slug || !numStr) return [];
  return [{ name: 'AniZone', sourceId: episodeId, type: 'sub' }];
}

export async function getAnizoneEmbedUrl(sourceId: string): Promise<AnizoneEmbedResult | null> {
  const [slug, numStr] = sourceId.split(':');
  const num = parseInt(numStr, 10);
  if (!slug || isNaN(num)) return null;

  try {
    const html = await fetchHtml(`${BASE}/anime/${slug}/${num}`);

    const hlsMatch = html.match(/<media-player[^>]+src="([^"]+\.m3u8[^"]*)"/i);
    const hls = hlsMatch ? decodeEntities(hlsMatch[1]) : null;

    const subtitles: AnizoneEmbedResult['subtitles'] = [];
    const trackRe = /<track\b([^>]*)>/gi;
    let t;
    while ((t = trackRe.exec(html)) !== null) {
      const attrs = t[1];
      const kind = attrs.match(/kind="([^"]*)"/i)?.[1] ?? '';
      if (kind !== 'subtitles') continue;
      const src = attrs.match(/src=["']?([^\s"'>]+)["']?/i)?.[1] ?? '';
      const label = attrs.match(/label="([^"]*)"/i)?.[1] ?? '';
      const srclang = attrs.match(/srclang="([^"]*)"/i)?.[1] ?? '';
      const dataType = attrs.match(/data-type="([^"]*)"/i)?.[1] ?? 'vtt';
      const isDefault = /\bdefault\b/.test(attrs);
      if (src) subtitles.push({ url: decodeEntities(src), label, lang: srclang, format: dataType, default: isDefault });
    }

    if (!hls) return null;
    return { embedUrl: `${BASE}/anime/${slug}/${num}`, m3u8: hls, referer: `${BASE}/`, subtitles };
  } catch {
    return null;
  }
}
