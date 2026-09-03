import { cacheGet, cacheSet } from '../utils/cache';

// ══════════════════════════════════════════════════════════════
// REANIME.TO — title/MAL-search + WASM-keystream embed decrypt
// (ported from Anivexa's reanime.js — Node's global crypto.subtle/atob/
// fetch make this a near-verbatim port of the original CF-Worker code)
// ══════════════════════════════════════════════════════════════

const BASE = 'https://reanime.to';
const FLIX = 'https://flixcloud.cc';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Accept: 'application/json, */*' };

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface ReanimeEpisode {
  num: number;
  id: string; // `${animeId}:${num}`
  title: string;
  hasSub: boolean;
  hasDub: boolean;
}

export interface ReanimeServer {
  name: string;
  sourceId: string; // embed url (dataLink)
  type: 'sub' | 'dub';
}

export interface ReanimeEmbedResult {
  embedUrl: string;
  m3u8: string | null;
  referer?: string;
  subtitles?: any[];
  thumbnails_vtt?: string | null;
  intro?: any;
  outro?: any;
}

async function sha256hex(s: string | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', (typeof s === 'string' ? enc.encode(s) : s) as any);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64toU8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveFields(seed: string) {
  let e = seed;
  for (let i = 0; i < 3; i++) e = await sha256hex(e + i);
  let l = e;
  for (let i = 0; i < 3; i++) l = await sha256hex(l + i);
  return {
    keyField: 'kf_' + e.substring(8, 16),
    ivField: 'ivf_' + e.substring(16, 24),
    containerName: 'cd_' + e.substring(24, 32),
    arrayName: 'ad_' + e.substring(32, 40),
    objectName: 'od_' + e.substring(40, 48),
    tokenField: e.substring(48, 64) + '_' + e.substring(56, 64),
    keyFrag2Field: l.substring(0, 16) + '_' + l.substring(16, 24),
  };
}

function extractSsrObj(html: string): string {
  const m = html.match(/\{type:"data",data:(\{)/);
  if (!m || m.index === undefined) throw new Error('SSR data block not found');
  let depth = 0;
  const start = html.indexOf('{', m.index + m[0].length - 1);
  for (let i = start; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      if (--depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error('SSR brace matching failed');
}

function parseJsLiteral(src: string): any {
  let i = 0;
  function ws() {
    while (i < src.length && /\s/.test(src[i])) i++;
  }
  function parseValue(): any {
    ws();
    if (src[i] === '{') return parseObject();
    if (src[i] === '[') return parseArray();
    if (src[i] === '"') return parseDStr();
    if (src[i] === "'") return parseSStr();
    if (src.startsWith('true', i)) { i += 4; return true; }
    if (src.startsWith('false', i)) { i += 5; return false; }
    if (src.startsWith('null', i)) { i += 4; return null; }
    if (src.startsWith('undefined', i)) { i += 9; return null; }
    if (src.startsWith('!0', i)) { i += 2; return true; }
    if (src.startsWith('!1', i)) { i += 2; return false; }
    const m = src.slice(i).match(/^-?[\d.]+([eE][+-]?\d+)?/);
    if (m) { i += m[0].length; return parseFloat(m[0]); }
    throw new Error(`JS parse error at pos ${i}: ...${src.slice(i, i + 20)}`);
  }
  function parseDStr(): string {
    let r = '';
    i++;
    while (i < src.length && src[i] !== '"') {
      if (src[i] === '\\') {
        i++;
        const e: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
        r += e[src[i]] ?? src[i];
        i++;
      } else r += src[i++];
    }
    i++;
    return r;
  }
  function parseSStr(): string {
    let r = '';
    i++;
    while (i < src.length && src[i] !== "'") {
      if (src[i] === '\\') {
        i++;
        r += src[i] === "'" ? "'" : ({ n: '\n', t: '\t', r: '\r', '\\': '\\' } as Record<string, string>)[src[i]] ?? src[i];
        i++;
      } else r += src[i++];
    }
    i++;
    return r;
  }
  function parseKey(): string {
    ws();
    if (src[i] === '"') return parseDStr();
    if (src[i] === "'") return parseSStr();
    const m = src.slice(i).match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/);
    if (m) { i += m[0].length; return m[0]; }
    throw new Error(`Bad key at pos ${i}: ${src.slice(i, i + 20)}`);
  }
  function parseObject(): any {
    const obj: any = {};
    i++;
    ws();
    while (i < src.length && src[i] !== '}') {
      if (src[i] === ',') { i++; ws(); continue; }
      const k = parseKey();
      ws();
      i++;
      obj[k] = parseValue();
      ws();
    }
    i++;
    return obj;
  }
  function parseArray(): any[] {
    const arr: any[] = [];
    i++;
    ws();
    while (i < src.length && src[i] !== ']') {
      if (src[i] === ',') { i++; ws(); continue; }
      arr.push(parseValue());
      ws();
    }
    i++;
    return arr;
  }
  return parseValue();
}

function parseWasmDecrypt(wasmBytes: Uint8Array) {
  const b = wasmBytes;
  let pos = 8;
  while (pos < b.length) {
    const secId = b[pos++];
    let sz = 0, sh = 0, by;
    do { by = b[pos++]; sz |= (by & 127) << sh; sh += 7; } while (by & 128);
    if (secId === 10) {
      pos++;
      let sbs = 0, sh2 = 0, by2;
      do { by2 = b[pos++]; sbs |= (by2 & 127) << sh2; sh2 += 7; } while (by2 & 128);
      pos += sbs;
      break;
    }
    pos += sz;
  }
  let rbs = 0, sh3 = 0, by3;
  do { by3 = b[pos++]; rbs |= (by3 & 127) << sh3; sh3 += 7; } while (by3 & 128);
  const r = b.slice(pos, pos + rbs);
  function leb(arr: Uint8Array, i: number): [number, number] {
    let v = 0, s = 0, b2;
    do { b2 = arr[i++]; v |= (b2 & 127) << s; s += 7; } while (b2 & 128);
    return [v, i];
  }
  const XOR_END = [32, 2, 32, 5, 106, 45, 0, 0, 115, 33, 6];
  let txStart = -1;
  outer: for (let i = 0; i < r.length - XOR_END.length; i++) {
    for (let j = 0; j < XOR_END.length; j++) if (r[i + j] !== XOR_END[j]) continue outer;
    txStart = i + XOR_END.length;
    break;
  }
  if (txStart < 0) throw new Error('WASM: transform start not found');
  let txEnd = -1, step = 36;
  for (let i = txStart; i < r.length - 4; i++) {
    if (r[i] === 32 && r[i + 1] === 5 && r[i + 2] === 65) {
      const [val, ni] = leb(r, i + 3);
      if (r[ni] === 108) { txEnd = i; step = val; break; }
    }
  }
  if (txEnd < 0) throw new Error('WASM: keystream not found');
  const code = r.slice(txStart, txEnd);
  function transform(inputByte: number): number {
    let local6 = inputByte & 255;
    const stk: number[] = [];
    let i = 0;
    while (i < code.length) {
      const op = code[i++];
      if (op === 32) { const [idx, ni] = leb(code, i); i = ni; stk.push(idx === 6 ? local6 : 0); }
      else if (op === 33) { const [idx, ni] = leb(code, i); i = ni; const v = stk.pop()!; if (idx === 6) local6 = v & 255; }
      else if (op === 65) { const [v, ni] = leb(code, i); i = ni; stk.push(v); }
      else if (op === 106) { const b2 = stk.pop()!, a = stk.pop()!; stk.push((a + b2) & 255); }
      else if (op === 107) { const b2 = stk.pop()!, a = stk.pop()!; stk.push((a - b2 + 256) & 255); }
      else if (op === 113) { const b2 = stk.pop()!, a = stk.pop()!; stk.push(a & b2 & 255); }
      else if (op === 114) { const b2 = stk.pop()!, a = stk.pop()!; stk.push((a | b2) & 255); }
      else if (op === 115) { const b2 = stk.pop()!, a = stk.pop()!; stk.push((a ^ b2) & 255); }
      else if (op === 116) { const b2 = stk.pop()!, a = stk.pop()!; stk.push((a << (b2 & 7)) & 255); }
      else if (op === 118) { const b2 = stk.pop()!, a = stk.pop()!; stk.push((a >>> (b2 & 7)) & 255); }
    }
    return local6;
  }
  return { step, transform };
}

function runDecrypt(wasmBytes: Uint8Array, frag1: Uint8Array, kf2: Uint8Array, T: Uint8Array, seedInt: number): Uint8Array {
  const { step, transform } = parseWasmDecrypt(wasmBytes);
  const out = new Uint8Array(frag1.length);
  for (let i = 0; i < frag1.length; i++) {
    const c = (frag1[i] ^ kf2[i] ^ T[i]) & 255;
    out[i] = (transform(c) ^ (i * step + seedInt)) & 255;
  }
  return out;
}

async function decryptEmbed(html: string): Promise<{ url: string; subtitles: any[]; thumbnails_vtt: string | null; intro_chapter: any; outro_chapter: any }> {
  const raw = extractSsrObj(html);
  const data = parseJsLiteral(raw);
  const seed = data.obfuscation_seed;
  if (!seed) throw new Error('obfuscation_seed missing');
  const fields = await deriveFields(seed);
  const ocd = data.obfuscated_crypto_data;
  if (!ocd) throw new Error('obfuscated_crypto_data missing');
  const container = ocd[fields.containerName];
  if (!container) throw new Error(`containerName "${fields.containerName}" not in ocd`);
  const arr = container[fields.arrayName];
  if (!arr) throw new Error(`arrayName "${fields.arrayName}" not in container`);
  const obj = arr[0][fields.objectName];
  if (!obj) throw new Error(`objectName "${fields.objectName}" not in arr[0]`);
  const frag1 = b64toU8(obj[fields.keyField]);
  const iv = b64toU8(obj[fields.ivField]);
  const kf2raw = data[fields.keyFrag2Field];
  if (!kf2raw) throw new Error(`kf2 field "${fields.keyFrag2Field}" not in data`);
  const kf2 = b64toU8(kf2raw);
  const token = data[fields.tokenField];
  if (!token) throw new Error(`tokenField "${fields.tokenField}" missing`);

  const tokRes = await fetch(`${FLIX}/api/m3u8/${token}`, { headers: { ...H, Referer: `${BASE}/` } });
  if (!tokRes.ok) throw new Error(`Token API ${tokRes.status}`);
  const tokData: any = await tokRes.json();

  const vidKey = (await sha256hex(token + 'vid')).substring(0, 10);
  const keyKey = (await sha256hex(token + 'key')).substring(0, 10);
  const v_bytes = b64toU8(tokData[vidKey]);
  const T_bytes = b64toU8(tokData[keyKey]);
  if (!v_bytes.length || !T_bytes.length) throw new Error(`Token fields missing. vidKey="${vidKey}" keyKey="${keyKey}"`);

  const seedInt = parseInt(seed.substring(0, 8), 16);
  const wPayload = b64toU8(data.w_payload ?? '');
  if (!wPayload.length) throw new Error('w_payload missing from embed data');
  const wasmOut = runDecrypt(wPayload, frag1, kf2, T_bytes, seedInt);

  const keyMat = await crypto.subtle.importKey('raw', wasmOut, { name: 'PBKDF2' }, false, ['deriveBits']);
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(seed), iterations: 1000, hash: 'SHA-256' }, keyMat, 256)
  );
  for (let i = 0; i < 32; i++) derived[i] ^= seed.charCodeAt(i % seed.length);
  const aesKeyBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', derived));
  const aesKey = await crypto.subtle.importKey('raw', aesKeyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aesKey, v_bytes);

  const url = dec.decode(plain).trim().replace(/\0+$/, '');
  if (!url.startsWith('http')) throw new Error(`Unexpected decrypted value: ${url.substring(0, 60)}`);
  return {
    url,
    subtitles: data.subtitles ?? [],
    thumbnails_vtt: data.thumbnails_vtt ?? null,
    intro_chapter: data.intro_chapter ?? null,
    outro_chapter: data.outro_chapter ?? null,
  };
}

// ── Series resolution / episode listing ──

async function searchReanime(query: string): Promise<any[]> {
  const res = await fetch(`${BASE}/api/v1/search?${new URLSearchParams({ q: query, limit: '10' })}`, { headers: H });
  if (!res.ok) throw new Error(`reanime search ${res.status}`);
  const data: any = await res.json();
  return Array.isArray(data?.results) ? data.results : [];
}

async function fetchAnimeDetail(animeId: string): Promise<any | null> {
  try {
    const res = await fetch(`${BASE}/api/v1/anime/${animeId}`, { headers: H });
    if (!res.ok) return null;
    return (await res.json()) as any;
  } catch {
    return null;
  }
}

function titleScoreSimple(query: string, candidate: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const na = norm(query), nb = norm(candidate);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (nb.includes(na) || na.includes(nb)) return 75;
  let matches = 0;
  for (const ch of na) if (nb.includes(ch)) matches++;
  return Math.floor((matches / Math.max(na.length, 1)) * 40);
}

export async function findReanimeSlug(title: string, malId: number | null): Promise<string | null> {
  const cacheKey = `reanime:slug:${title.toLowerCase().trim()}`;
  const cached = cacheGet<string>(cacheKey);
  if (cached) return cached;

  const candidates = await searchReanime(title).catch(() => []);
  if (!candidates.length) return null;

  if (malId) {
    const details = await Promise.all(candidates.map((c: any) => fetchAnimeDetail(c.anime_id)));
    for (let i = 0; i < candidates.length; i++) {
      if (details[i]?.mal_id && Number(details[i].mal_id) === Number(malId)) {
        cacheSet(cacheKey, candidates[i].anime_id, 'mapping');
        return candidates[i].anime_id;
      }
    }
  }

  const scored = candidates
    .map((c: any) => ({ id: c.anime_id, score: titleScoreSimple(title, c.title?.english || c.title?.romaji || c.anime_id) }))
    .sort((a: any, b: any) => b.score - a.score);
  if (scored[0] && scored[0].score >= 40) {
    cacheSet(cacheKey, scored[0].id, 'mapping');
    return scored[0].id;
  }
  return null;
}

async function fetchEpisodesList(animeId: string): Promise<any[]> {
  const res = await fetch(`${BASE}/api/v1/anime/${animeId}/episodes?${new URLSearchParams({ limit: '2000' })}`, { headers: H });
  if (!res.ok) throw new Error(`reanime episodes ${res.status}`);
  const data: any = await res.json();
  return Array.isArray(data?.data) ? data.data : [];
}

export async function getReanimeEpisodes(slug: string): Promise<ReanimeEpisode[]> {
  const cacheKey = `reanime:eps:${slug}`;
  const cached = cacheGet<ReanimeEpisode[]>(cacheKey);
  if (cached) return cached;

  const [eps, detail] = await Promise.all([fetchEpisodesList(slug), fetchAnimeDetail(slug)]);
  const dubCount = detail?.dubbed ?? 0;
  const episodes: ReanimeEpisode[] = eps
    .map((ep: any) => {
      const num = ep.episode_number;
      return {
        num,
        id: `${slug}:${num}`,
        title: ep.title || `Episode ${num}`,
        hasSub: true,
        hasDub: dubCount > 0 && num <= dubCount,
      };
    })
    .sort((a, b) => a.num - b.num);

  if (episodes.length) cacheSet(cacheKey, episodes, 'episodes');
  return episodes;
}

export async function getReanimeServers(episodeId: string): Promise<ReanimeServer[]> {
  const [slug, numStr] = episodeId.split(':');
  const ep = parseInt(numStr, 10);
  if (!slug || isNaN(ep)) return [];

  const order: Record<string, number> = { 'HD-2': 0, 'HD-1': 1 };
  const byPrio = (arr: any[]) => arr.slice().sort((a, b) => (order[a.serverName] ?? 9) - (order[b.serverName] ?? 9));

  // NOTE: Anivexa's /api/flix/:anilistId/:ep mirror endpoint is keyed by
  // AniList ID, which this scraper's episodeId (slug:num) doesn't carry —
  // our other scrapers all use a single opaque episode-id string, so we
  // don't thread anilistId through here either. We fall back to reanime's
  // own /api/watch/:slug/:ep server list only; flixRes below will reject
  // and Promise.allSettled just drops it, same net effect minus the mirror.
  const [watchRes, flixRes] = await Promise.allSettled([
    fetch(`${BASE}/api/watch/${slug}/${ep}`, { headers: H }).then((r) => (r.ok ? (r.json() as Promise<any>) : Promise.reject(new Error(`watch ${r.status}`)))),
    fetch(`${BASE}/api/flix/${slug}/${ep}`, { headers: H }).then((r) => (r.ok ? (r.json() as Promise<any>) : Promise.reject(new Error(`flix ${r.status}`)))),
  ]);
  const watchData = watchRes.status === 'fulfilled' ? watchRes.value : null;
  const flixData = flixRes.status === 'fulfilled' ? flixRes.value : null;

  const links: any[] = [...(watchData?.episode_links ?? [])];
  if (flixData?.success && flixData?.servers) {
    const seen = new Set(links.map((s) => s['$id']));
    for (const s of flixData.servers) if (!seen.has(s['$id'])) links.push(s);
  }

  const servers: ReanimeServer[] = [];
  for (const s of byPrio(links)) {
    const type: 'sub' | 'dub' | null = s.dataType === 'sub' || s.dataType === 's-sub' ? 'sub' : s.dataType === 'dub' || s.dataType === 's-dub' ? 'dub' : null;
    if (!type || !s.dataLink) continue;
    servers.push({ name: s.serverName ?? 'ReAnime', sourceId: s.dataLink, type });
  }
  return servers;
}

export async function getReanimeEmbedUrl(sourceId: string): Promise<ReanimeEmbedResult | null> {
  try {
    const res = await fetch(sourceId, { headers: { ...H, Referer: `${BASE}/` } });
    if (!res.ok) return null;
    const html = await res.text();
    const stream = await decryptEmbed(html);
    return {
      embedUrl: sourceId,
      m3u8: stream.url,
      referer: `${FLIX}/`,
      subtitles: stream.subtitles ?? [],
      thumbnails_vtt: stream.thumbnails_vtt ?? null,
      intro: stream.intro_chapter ?? null,
      outro: stream.outro_chapter ?? null,
    };
  } catch {
    return null;
  }
}
