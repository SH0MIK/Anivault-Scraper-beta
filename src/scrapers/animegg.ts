import { attr, fetchHtml, findBestSlug, stripTags } from './_shared';
import { cacheGet, cacheSet } from '../utils/cache';

// ══════════════════════════════════════════════════════════════
// ANIMEGG.ORG — title-search + HTML/regex scraper
// (ported from Anivexa's animegg.js)
// ══════════════════════════════════════════════════════════════

const BASE = 'https://www.animegg.org';

export interface AnimeggEpisode {
  num: number;
  id: string; // epSlug (relative path)
  title: string;
  hasSub: boolean;
  hasDub: boolean;
}

export interface AnimeggServer {
  name: string;
  sourceId: string; // direct file url, or `embed::<url>` fallback
  type: 'sub' | 'dub';
}

export interface AnimeggEmbedResult {
  embedUrl: string;
  m3u8: string | null;
  referer?: string;
}

async function search(query: string): Promise<{ slug: string; text: string }[]> {
  const html = await fetchHtml(`${BASE}/search/?q=${encodeURIComponent(query)}`);
  const results: { slug: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*class=["'][^"']*\bmse\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi)) {
    const tag = m[0].match(/<a\b[^>]*>/i)?.[0] ?? '';
    const href = attr(tag, 'href');
    const slug = href.match(/^\/series\/([^/?#]+)/)?.[1];
    if (!slug) continue;
    const strong = m[0].match(/<strong[^>]*>([\s\S]*?)<\/strong>/i)?.[1];
    results.push({ slug, text: strong ? stripTags(strong) : slug.replace(/-/g, ' ') });
  }
  return results;
}

export async function findAnimeggSlug(title: string, altTitle?: string | null): Promise<string | null> {
  return findBestSlug('animegg:slug', title, altTitle, search);
}

interface RawEpisode {
  number: number;
  title: string;
  epSlug: string;
  hasSub: boolean;
  hasDub: boolean;
}

async function scrapeSeries(slug: string): Promise<RawEpisode[]> {
  const cacheKey = `animegg:eps:${slug}`;
  const cached = cacheGet<RawEpisode[]>(cacheKey);
  if (cached) return cached;

  const html = await fetchHtml(`${BASE}/series/${slug}`);
  const episodes: RawEpisode[] = [];
  for (const m of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const block = m[1];
    if (!/\banm_det_pop\b/.test(block)) continue;
    const link = block.match(/<a\b[^>]*class=["'][^"']*anm_det_pop[^"']*["'][^>]*>/i)?.[0] ?? '';
    const href = attr(link, 'href').replace(/#.*$/, '').replace(/^\//, '');
    const strong = stripTags(block.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i)?.[1] ?? '');
    const rangeMatch = strong.match(/(\d+)-(\d+)\s*$/);
    const numMatch = rangeMatch || strong.match(/(\d+)\s*$/);
    if (!numMatch || !href) continue;
    const number = parseInt(numMatch[1], 10);
    const title = stripTags(block.match(/<i\b[^>]*class=["'][^"']*anititle[^"']*["'][^>]*>([\s\S]*?)<\/i>/i)?.[1] ?? '') || strong;
    episodes.push({
      number,
      title,
      epSlug: href,
      hasSub: /\bbtn-subbed\b/.test(block),
      hasDub: /\bbtn-dubbed\b/.test(block),
    });
  }
  episodes.sort((a, b) => a.number - b.number);
  const seen = new Set<number>();
  const unique = episodes.filter((e) => (seen.has(e.number) ? false : (seen.add(e.number), true)));
  if (unique.length) cacheSet(cacheKey, unique, 'episodes');
  return unique;
}

export async function getAnimeggEpisodes(slug: string): Promise<AnimeggEpisode[]> {
  const raw = await scrapeSeries(slug);
  return raw.map((ep) => ({ num: ep.number, id: ep.epSlug, title: ep.title, hasSub: ep.hasSub, hasDub: ep.hasDub }));
}

async function scrapeEmbed(embedId: string): Promise<{ quality: string; url: string }[]> {
  const html = await fetchHtml(`${BASE}/embed/${embedId}`, { Referer: BASE });
  const m = html.match(/var\s+videoSources\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) return [];
  try {
    const asJson = m[1]
      .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
      .replace(/:\s*'([^']*)'/g, ': "$1"');
    const parsed = JSON.parse(asJson);
    return parsed
      .map((s: any) => ({
        quality: s.label || 'unknown',
        url: s.file ? (String(s.file).startsWith('http') ? s.file : `${BASE}${s.file}`) : '',
      }))
      .filter((s: any) => s.url);
  } catch {
    return [];
  }
}

export async function getAnimeggServers(episodeId: string): Promise<AnimeggServer[]> {
  const html = await fetchHtml(`${BASE}/${episodeId}`, { Referer: BASE });
  const tabs: { embedId: string; embedUrl: string; server: string; normalized: 'sub' | 'dub' }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*data-toggle=["']tab["'][^>]*>/gi)) {
    const tag = m[0];
    const embedId = attr(tag, 'data-id');
    const server = attr(tag, 'data-mirror') || 'AnimeGG';
    const version = attr(tag, 'data-version') || 'subbed';
    if (!embedId) continue;
    tabs.push({ embedId, embedUrl: `${BASE}/embed/${embedId}`, server, normalized: version.startsWith('dub') ? 'dub' : 'sub' });
  }

  const servers: AnimeggServer[] = [];
  await Promise.all(
    tabs.map(async (tab) => {
      const sources = await scrapeEmbed(tab.embedId).catch(() => []);
      if (sources.length) {
        for (const s of sources) {
          servers.push({ name: `${tab.server} ${s.quality}`, sourceId: s.url, type: tab.normalized });
        }
      } else {
        servers.push({ name: `${tab.server}-embed`, sourceId: `embed::${tab.embedUrl}`, type: tab.normalized });
      }
    })
  );
  return servers;
}

export async function getAnimeggEmbedUrl(sourceId: string): Promise<AnimeggEmbedResult | null> {
  if (sourceId.startsWith('embed::')) {
    return { embedUrl: sourceId.slice('embed::'.length), m3u8: null, referer: BASE };
  }
  return { embedUrl: sourceId, m3u8: sourceId.includes('.m3u8') ? sourceId : null, referer: BASE };
}
