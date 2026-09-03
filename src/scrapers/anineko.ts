import * as cheerio from 'cheerio';
import { makeClient } from '../utils/fetch';
import { findBestSlug } from './_shared';
import { cacheGet, cacheSet } from '../utils/cache';

// ══════════════════════════════════════════════════════════════
// ANINEKO.TO — title-search + cheerio scraper
// (ported from Anivexa's anineko.js)
// ══════════════════════════════════════════════════════════════

const BASE = 'https://anineko.to';
const http = makeClient(BASE, BASE + '/');

export interface AninekoEpisode {
  num: number;
  id: string; // `${slug}:${num}`
  title: string;
  hasSub: boolean;
  hasDub: boolean;
}

export interface AninekoServer {
  name: string;
  sourceId: string; // embed url
  type: 'sub' | 'dub';
}

export interface AninekoEmbedResult {
  embedUrl: string;
  m3u8: string | null;
  referer?: string;
}

async function search(query: string): Promise<{ slug: string; text: string }[]> {
  const res = await http.get('/browser', { params: { keyword: query } });
  const $ = cheerio.load(res.data);
  const results: { slug: string; text: string }[] = [];
  $('a[class*="nv-anime-thumb"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') ?? '';
    const slugMatch = href.match(/\/watch\/([^/?#]+)/);
    if (!slugMatch) return;
    const title = $el.find('[class*="nv-anime-title"], h3').first().text().trim() || slugMatch[1].replace(/-/g, ' ');
    results.push({ slug: slugMatch[1], text: title });
  });
  return results;
}

export async function findAninekoSlug(title: string, altTitle?: string | null): Promise<string | null> {
  return findBestSlug('anineko:slug', title, altTitle, search);
}

interface RawEpisode {
  num: number;
  title: string;
  hasSub: boolean;
  hasDub: boolean;
}

async function fetchRawEpisodes(slug: string): Promise<RawEpisode[]> {
  const cacheKey = `anineko:eps:${slug}`;
  const cached = cacheGet<RawEpisode[]>(cacheKey);
  if (cached) return cached;

  const res = await http.get(`/watch/${slug}`);
  const $ = cheerio.load(res.data);
  const episodes: RawEpisode[] = [];
  $('article[class*="nv-info-episode-item"]').each((_, el) => {
    const $el = $(el);
    const link = $el.find('a[class*="nv-info-episode-main"]').first();
    const href = link.attr('href') ?? '';
    const numMatch = href.match(/\/ep-(\d+)/);
    if (!numMatch) return;
    const num = Number(numMatch[1]);
    const title = link.find('span').first().text().trim() || `Episode ${num}`;
    const badges = $el
      .find('span')
      .map((_, s) => $(s).text().trim().toLowerCase())
      .get();
    episodes.push({ num, title, hasSub: badges.includes('sub'), hasDub: badges.includes('dub') });
  });
  episodes.sort((a, b) => a.num - b.num);
  const seen = new Set<number>();
  const unique = episodes.filter((e) => (seen.has(e.num) ? false : (seen.add(e.num), true)));
  if (unique.length) cacheSet(cacheKey, unique, 'episodes');
  return unique;
}

export async function getAninekoEpisodes(slug: string): Promise<AninekoEpisode[]> {
  const raw = await fetchRawEpisodes(slug);
  return raw.map((ep) => ({ num: ep.num, id: `${slug}:${ep.num}`, title: ep.title, hasSub: ep.hasSub, hasDub: ep.hasDub }));
}

export async function getAninekoServers(episodeId: string): Promise<AninekoServer[]> {
  const [slug, numStr] = episodeId.split(':');
  const num = parseInt(numStr, 10);
  if (!slug || isNaN(num)) return [];

  const res = await http.get(`/watch/${slug}/ep-${num}`, { headers: { Referer: `${BASE}/watch/${slug}` } });
  const $ = cheerio.load(res.data);
  const servers: AninekoServer[] = [];
  $('div[class*="nv-server-grid"]').each((_, panel) => {
    const $panel = $(panel);
    const dataId = ($panel.attr('data-id') ?? '').toLowerCase();
    const audio: 'sub' | 'dub' = dataId.includes('dub') ? 'dub' : 'sub';
    $panel.find('[data-video]').each((_, btn) => {
      const embed = $(btn).attr('data-video');
      if (embed) servers.push({ name: 'AniNeko', sourceId: embed, type: audio });
    });
  });
  return servers;
}

async function extractHls(embedUrl: string): Promise<string | null> {
  try {
    const res = await http.get(embedUrl, { headers: { Referer: `${BASE}/` } });
    const html = String(res.data);
    const patterns = [
      /const\s+src\s*=\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
      /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
      /["'](https?:\/\/[^"']+\/master\.m3u8[^"']*)["']/i,
      /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

export async function getAninekoEmbedUrl(sourceId: string): Promise<AninekoEmbedResult | null> {
  const hls = await extractHls(sourceId);
  return { embedUrl: sourceId, m3u8: hls, referer: `${BASE}/` };
}
