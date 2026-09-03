import axios from 'axios';

// ══════════════════════════════════════════════════════════════
// Shared utilities for the Anivexa-ported scrapers (reanime, anineko,
// anizone, dhive, kaa, senshi, animegg, anibd, animedunya, anidbapp,
// animenosub). No FlareSolverr is used anywhere here — plain headers only.
// ══════════════════════════════════════════════════════════════

export const SHARED_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export async function fetchHtml(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await axios.get(url, {
    headers: {
      'User-Agent': SHARED_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...headers,
    },
    timeout: 15000,
  });
  return String(res.data);
}

export async function fetchJson<T = any>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await axios.get(url, {
    headers: { 'User-Agent': SHARED_UA, Accept: 'application/json', ...headers },
    timeout: 15000,
  });
  return res.data as T;
}

export function decodeEntities(s = ''): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

export function stripTags(html = ''): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
}

export function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`${name}=["']([^"']*)["']`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

export function norm(s = ''): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function diceCoeff(a: string, b: string): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < na.length - 1; i++) {
    const bg = na.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < nb.length - 1; i++) {
    const bg = nb.slice(i, i + 2);
    const count = bigrams.get(bg) ?? 0;
    if (count > 0) {
      hits++;
      bigrams.set(bg, count - 1);
    }
  }
  return (2 * hits) / (na.length + nb.length - 2);
}

export function titleScore(query: string, candidate: string, slug: string): number {
  const base = Math.max(diceCoeff(query, candidate), diceCoeff(query, slug.replace(/-/g, ' ')));
  const queryFirstNum = norm(query).match(/\d+/)?.[0] ?? '';
  const slugFirstNum = slug.match(/\d+/)?.[0] ?? '';
  if (queryFirstNum && slugFirstNum && queryFirstNum !== slugFirstNum) return base * 0.65;
  if (queryFirstNum && !slugFirstNum) return base * 0.65;
  if (!queryFirstNum && slugFirstNum) {
    const n = parseInt(slugFirstNum, 10);
    if (n > 1 && n < 1900) return base * (1 - 0.06 * (n - 1));
  }
  const isMovieQuery = /\b(movie|film|the movie)\b/i.test(query);
  const isMovieMatch = /\b(movie|film)\b/i.test(candidate) || /movie|film/.test(slug);
  if (isMovieQuery && !isMovieMatch) return base * 0.4;
  const qLen = norm(query).length;
  const sLen = norm(slug.replace(/-/g, ' ')).length;
  return sLen > qLen * 1.6 + 4 ? base * 0.8 : base;
}

function buildSearchQueries(title: string): string[] {
  const queries = new Set<string>([title]);
  const words = title.trim().split(/\s+/);
  if (words.length > 4) queries.add(words.slice(0, 4).join(' '));
  if (words.length > 3) queries.add(words.slice(0, 3).join(' '));
  const stripped = title
    .replace(/\bseason\s*\d+\b/gi, '')
    .replace(/\bpart\s*\d+\b/gi, '')
    .replace(/\b\d+rd\b|\b\d+th\b|\b\d+st\b|\b\d+nd\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped && stripped !== title) queries.add(stripped);
  return [...queries].filter((q) => q.length >= 3);
}

export interface SlugCandidate {
  slug: string;
  title: string;
  score: number;
}

// Search across a few title variants, score every unique candidate against
// the requested titles, and return the best matches sorted descending.
// This mirrors Anivexa's findTopSlugs()/titleScore() but doesn't do the
// (expensive) episode-count cross-check pass selectSeries() did — same
// simplification this repo's own anikoto.ts/desidub.ts already make.
export async function findTopSlugs(
  titles: string[],
  searchFn: (q: string) => Promise<{ slug: string; text: string }[]>,
  n = 6
): Promise<SlugCandidate[]> {
  const allCandidates = new Map<string, string>();
  const searchQueries = new Set<string>();
  for (const title of titles.slice(0, 3)) {
    for (const q of buildSearchQueries(title)) searchQueries.add(q);
  }
  await Promise.all(
    [...searchQueries].map(async (q) => {
      try {
        const results = await searchFn(q);
        for (const r of results) if (!allCandidates.has(r.slug)) allCandidates.set(r.slug, r.text);
      } catch {
        // one query failing shouldn't sink the whole match attempt
      }
    })
  );
  const scored: SlugCandidate[] = [];
  for (const [slug, text] of allCandidates) {
    let best = 0;
    for (const title of titles.slice(0, 2)) best = Math.max(best, titleScore(title, text, slug));
    if (best >= 0.5) scored.push({ slug, title: text, score: best });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, n);
}

// Convenience: run findTopSlugs across `title` + optional `altTitle`, cache
// the winning slug under `cachePrefix:normalizedTitle`, and return it (or
// null). Used by every title-search-based scraper below.
import { cacheGet, cacheSet } from '../utils/cache';

export async function findBestSlug(
  cachePrefix: string,
  title: string,
  altTitle: string | null | undefined,
  searchFn: (q: string) => Promise<{ slug: string; text: string }[]>
): Promise<string | null> {
  const cacheKey = `${cachePrefix}:${title.toLowerCase().trim()}`;
  const cached = cacheGet<string>(cacheKey);
  if (cached) return cached;

  const titles = [title, altTitle].filter((t): t is string => Boolean(t && t !== 'Unknown'));
  if (!titles.length) return null;

  const candidates = await findTopSlugs(titles, searchFn);
  if (!candidates.length) return null;

  cacheSet(cacheKey, candidates[0].slug, 'mapping');
  return candidates[0].slug;
}
