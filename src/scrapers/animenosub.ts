import crypto from 'node:crypto';
import { decodeEntities, fetchHtml, findBestSlug } from './_shared';
import { cacheGet, cacheSet } from '../utils/cache';

// ══════════════════════════════════════════════════════════════
// ANIMENOSUB.TO — title-search scraper with three embed resolvers:
// Byse (ECDSA attestation + proof-of-work + AES-GCM), Nova (AES-128-CBC),
// Vidmoly (plain regex). Ported from Anivexa's animenosub.js — Node's
// global crypto.subtle / atob / fetch make this a near-verbatim port.
// ══════════════════════════════════════════════════════════════

const BASE = 'https://animenosub.to';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface AnimenosubEpisode {
  num: number;
  id: string; // `${encodeURIComponent(epUrl)}::${audio}`
  title: string;
}

export interface AnimenosubServer {
  name: string;
  sourceId: string; // embed url
  type: 'sub' | 'dub';
}

export interface AnimenosubEmbedResult {
  embedUrl: string;
  m3u8: string | null;
  referer?: string;
}

// ── Byse: ECDSA client attestation + proof-of-work challenge + AES-GCM ──

function b64u(buf: Uint8Array | Buffer): string {
  return Buffer.from(buf).toString('base64url');
}
function b64uDec(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

const _be = 512, _lt = _be - 1, _dr = 2, _lr = 2654435761, _hr = 2246822519;
const _rot = (t: number, e: number) => (t << e) | (t >>> (32 - e));
const _mul = (t: number, e: number) => Math.imul(t, e) >>> 0;

function _mix(t: Uint32Array) {
  t[0] = (t[0] + t[1]) >>> 0; t[3] = _rot(t[3] ^ t[0], 16) >>> 0;
  t[2] = (t[2] + t[3]) >>> 0; t[1] = _rot(t[1] ^ t[2], 12) >>> 0;
  t[0] = (t[0] + t[1]) >>> 0; t[3] = _rot(t[3] ^ t[0], 8) >>> 0;
  t[2] = (t[2] + t[3]) >>> 0; t[1] = _rot(t[1] ^ t[2], 7) >>> 0;
}

function _hash(t: Uint8Array): Uint32Array {
  const e = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762]);
  for (let i = 0; i < t.length; i++) {
    e[0] = (e[0] + t[i]) >>> 0;
    e[0] = _rot(e[0], 7) >>> 0;
    _mix(e);
  }
  for (let i = 0; i < 8; i++) _mix(e);
  const r = new Uint32Array(_be);
  for (let i = 0; i < _be; i++) {
    _mix(e);
    r[i] = (e[0] ^ e[2]) >>> 0;
  }
  for (let i = 0; i < _dr; i++) {
    for (let s = 0; s < _be; s++) {
      const a = r[s] & _lt;
      let c = (r[s] + r[a]) >>> 0;
      c = _rot(c, 13) >>> 0;
      c = (c ^ _mul(r[(s + 1) & _lt], _lr)) >>> 0;
      r[s] = c;
      e[0] = (e[0] ^ c) >>> 0;
      _mix(e);
    }
  }
  const n = new Uint32Array(8), o = _be / 8;
  for (let i = 0; i < 8; i++) {
    _mix(e);
    let s = e[0];
    const a = i * o;
    for (let c = 0; c < o; c++) {
      const d = r[a + c];
      s = (s + d) >>> 0;
      s = _rot(s, 5) >>> 0;
      s = (s ^ _mul(d, _hr)) >>> 0;
    }
    n[i] = (s ^ e[2]) >>> 0;
  }
  return n;
}

function _latin1Bytes(t: string): Uint8Array {
  const e = new Uint8Array(t.length);
  for (let r = 0; r < t.length; r++) e[r] = t.charCodeAt(r) & 255;
  return e;
}
function _leadingZeros(t: Uint32Array): number {
  let e = 0;
  for (let r = 0; r < t.length; r++) {
    const n = t[r];
    if (n === 0) { e += 32; continue; }
    return e + Math.clz32(n);
  }
  return e;
}
function solvePoW(nonce: string, difficulty: number): string {
  const prefix = nonce + ':';
  for (let s = 0; ; s++) {
    if (_leadingZeros(_hash(_latin1Bytes(prefix + s))) >= difficulty) return String(s);
  }
}

async function resolveByse(embedUrl: string): Promise<string[]> {
  const code = embedUrl.match(/\/e\/([a-z0-9]+)/i)?.[1];
  if (!code) throw new Error(`Cannot extract Byse code from ${embedUrl}`);

  const det: any = await (
    await fetch(`https://bysesayeveum.com/api/videos/${code}/embed/details`, { headers: { 'User-Agent': UA, Referer: embedUrl } })
  ).json();

  const frameUrl = det.embed_frame_url;
  const frameBase = new URL(frameUrl).origin;

  const ch: any = await (
    await fetch(`${frameBase}/api/videos/access/challenge`, {
      method: 'POST',
      headers: { 'Content-Length': '0', Origin: frameBase, Referer: frameUrl, 'User-Agent': UA },
    })
  ).json();

  const keyPair = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const pubJwk = await crypto.webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
  const sig = await crypto.webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, new TextEncoder().encode(ch.nonce));

  const att: any = await (
    await fetch(`${frameBase}/api/videos/access/attest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: frameBase, Referer: frameUrl, 'User-Agent': UA },
      body: JSON.stringify({ nonce: ch.nonce, challenge_id: ch.challenge_id, public_key: pubJwk, signature: b64u(new Uint8Array(sig)) }),
    })
  ).json();

  const viewerId = att.viewer_id, deviceId = att.device_id, fpToken = att.token, confidence = att.confidence;
  const cookieStr = `byse_viewer_id=${viewerId}; byse_device_id=${deviceId}`;
  const fingerprint = { token: fpToken, viewer_id: viewerId, device_id: deviceId, confidence };

  const cap: any = await (
    await fetch(`${frameBase}/api/videos/${code}/embed/captcha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: frameBase, Referer: frameUrl, 'User-Agent': UA, Cookie: cookieStr, 'X-Embed-Parent': embedUrl },
      body: '{}',
    })
  ).json();

  const solution = solvePoW(cap.pow_nonce, cap.pow_difficulty);

  const ver: any = await (
    await fetch(`${frameBase}/api/videos/${code}/embed/captcha/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: frameBase, Referer: frameUrl, 'User-Agent': UA, Cookie: cookieStr, 'X-Embed-Parent': embedUrl },
      body: JSON.stringify({ pow_token: cap.pow_token, solution, fingerprint }),
    })
  ).json();

  const pbData: any = await (
    await fetch(`${frameBase}/api/videos/${code}/embed/playback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: frameBase,
        Referer: frameUrl,
        'User-Agent': UA,
        Cookie: cookieStr,
        'X-Captcha-Token': ver.token,
        'X-Embed-Parent': embedUrl,
      },
      body: JSON.stringify({ fingerprint }),
    })
  ).json();

  const pb = pbData.playback;
  const keyBytes = Buffer.concat(pb.key_parts.filter((k: string) => b64uDec(k).length === 16).map((k: string) => b64uDec(k)));
  const aesKey = await crypto.webcrypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  const dec = await crypto.webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: b64uDec(pb.iv) }, aesKey, b64uDec(pb.payload));
  const playback = JSON.parse(new TextDecoder().decode(dec));
  return playback.sources.map((s: any) => s.url);
}

// ── Nova: AES-128-CBC ──

const NOVA_KEY = Buffer.from('6b69656d7469656e6d75613931316361', 'hex');
const NOVA_IV = Buffer.from('313233343536373839306f6975797472', 'hex');

async function resolveNova(embedUrl: string): Promise<string[]> {
  const id = embedUrl.match(/upn\.one\/#([A-Za-z0-9]+)/i)?.[1];
  if (!id) throw new Error(`Cannot extract Nova id from ${embedUrl}`);

  const res = await fetch(`https://nova.upn.one/api/v1/video?id=${id}&w=1920&h=1080&r=`, {
    headers: { 'User-Agent': UA, Referer: 'https://nova.upn.one/' },
  });
  if (!res.ok) throw new Error(`Nova fetch HTTP ${res.status}`);
  const hex = (await res.text()).trim();
  const decipher = crypto.createDecipheriv('aes-128-cbc', NOVA_KEY, NOVA_IV);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]);
  const data = JSON.parse(decrypted.toString('utf8'));
  const m3u8 = data.cf ?? data.source;
  if (!m3u8) throw new Error('Nova response missing m3u8 url');
  return [m3u8];
}

// ── Vidmoly: plain regex ──

async function resolveVidmoly(embedUrl: string): Promise<string[]> {
  const url = embedUrl.startsWith('//') ? `https:${embedUrl}` : embedUrl;
  const html = await fetchHtml(url, { Referer: `${BASE}/` });
  const m = html.match(/sources:\s*\[\s*\{\s*file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/);
  if (!m) throw new Error('Vidmoly m3u8 not found in embed HTML');
  return [m[1]];
}

function isByse(url: string) { return /bysesayeveum\.com\/e\//i.test(url); }
function isVidmoly(url: string) { return /vidmoly\.(net|biz|to)/i.test(url); }
function isNova(url: string) { return /upn\.one/i.test(url); }

// ── Search / episode listing ──

async function search(query: string): Promise<{ slug: string; text: string }[]> {
  const res = await fetch(`${BASE}/wp-admin/admin-ajax.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': UA,
      Origin: BASE,
      Referer: `${BASE}/`,
    },
    body: `action=ts_ac_do_search&ts_ac_query=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`animenosub search HTTP ${res.status}`);
  const data: any = await res.json();
  const results: { slug: string; text: string }[] = [];
  for (const item of data?.anime?.[0]?.all ?? []) {
    const slug = item.post_link?.match(/\/anime\/([^/]+)\/?$/)?.[1];
    if (!slug) continue;
    results.push({ slug, text: item.post_title ?? slug.replace(/-/g, ' ') });
  }
  return results;
}

export async function findAnimenosubSlug(title: string, altTitle?: string | null): Promise<string | null> {
  return findBestSlug('animenosub:slug', title, altTitle, search);
}

interface RawEpisode {
  number: number;
  title: string;
  epUrl: string;
  hasSub: boolean;
  hasDub: boolean;
}

async function scrapeSeries(slug: string): Promise<RawEpisode[]> {
  const cacheKey = `animenosub:eps:${slug}`;
  const cached = cacheGet<RawEpisode[]>(cacheKey);
  if (cached) return cached;

  const html = await fetchHtml(`${BASE}/anime/${slug}/`, { Referer: BASE });
  const isSlugDub = /-dub$/.test(slug) || /(?:^|[-\s])dub(?:$|[-\s])/i.test(slug);
  const episodes: RawEpisode[] = [];
  const seen = new Set<number>();
  const listRe = /<li\b[^>]*data-index="\d+"[^>]*>[\s\S]*?<a\s+href="(https?:\/\/animenosub\.to\/[^"]+)"[\s\S]*?<div\s+class="epl-num">([^<]+)<\/div>/gi;
  for (const m of html.matchAll(listRe)) {
    const epUrl = decodeEntities(m[1]);
    const label = m[2].trim();
    let number: number | null;
    if (/^movie$/i.test(label)) {
      number = 1;
    } else {
      const n = parseFloat(label);
      number = Number.isFinite(n) && n >= 1 ? Math.round(n) : null;
    }
    if (number === null || seen.has(number)) continue;
    seen.add(number);
    const isDub = isSlugDub || /-dub(?:$|\/)/.test(epUrl);
    episodes.push({ number, title: /^movie$/i.test(label) ? 'Movie' : `Episode ${number}`, epUrl, hasSub: !isDub, hasDub: isDub });
  }
  episodes.sort((a, b) => a.number - b.number);
  if (episodes.length) cacheSet(cacheKey, episodes, 'episodes');
  return episodes;
}

export async function getAnimenosubEpisodes(slug: string): Promise<AnimenosubEpisode[]> {
  const raw = await scrapeSeries(slug);
  return raw.map((ep) => ({
    num: ep.number,
    id: `${encodeURIComponent(ep.epUrl)}::${ep.hasDub ? 'dub' : 'sub'}`,
    title: ep.title,
  }));
}

async function scrapeEmbeds(epUrl: string): Promise<{ url: string; server: string }[]> {
  const html = await fetchHtml(epUrl, { Referer: `${BASE}/` });
  const streams: { url: string; server: string }[] = [];
  for (const m of html.matchAll(/<option\s+value="([A-Za-z0-9+/=]+)"\s+data-index="\d+"[^>]*>([^<]+)<\/option>/gi)) {
    const b64 = m[1];
    const serverName = m[2].trim();
    if (!serverName || /select video server/i.test(serverName)) continue;
    let embedUrl: string | null = null;
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      embedUrl = decoded.match(/src=["']([^"']+)["']/i)?.[1] ?? null;
    } catch {
      continue;
    }
    if (!embedUrl) continue;
    streams.push({ url: embedUrl, server: serverName });
  }
  if (!streams.length) {
    for (const m of html.matchAll(/<iframe[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
      const src = m[1];
      if (/vidmoly|vtbe|streamtape|dood|filemoon|upn\.one|bysesa/i.test(src)) {
        streams.push({ url: src, server: 'Direct' });
        break;
      }
    }
  }
  return streams;
}

export async function getAnimenosubServers(episodeId: string): Promise<AnimenosubServer[]> {
  const [encodedUrl, audio] = episodeId.split('::');
  if (!encodedUrl || !audio) return [];
  const epUrl = decodeURIComponent(encodedUrl);
  const embeds = await scrapeEmbeds(epUrl).catch(() => []);
  return embeds.map((e) => ({ name: e.server, sourceId: e.url, type: audio as 'sub' | 'dub' }));
}

export async function getAnimenosubEmbedUrl(sourceId: string): Promise<AnimenosubEmbedResult | null> {
  try {
    if (isByse(sourceId)) {
      const urls = await resolveByse(sourceId);
      return { embedUrl: sourceId, m3u8: urls[0] ?? null, referer: 'https://bysesayeveum.com/' };
    }
    if (isVidmoly(sourceId)) {
      const urls = await resolveVidmoly(sourceId);
      return { embedUrl: sourceId, m3u8: urls[0] ?? null, referer: 'https://vidmoly.biz/' };
    }
    if (isNova(sourceId)) {
      const urls = await resolveNova(sourceId);
      return { embedUrl: sourceId, m3u8: urls[0] ?? null, referer: 'https://nova.upn.one/' };
    }
  } catch {
    // fall through to iframe-only
  }
  return { embedUrl: sourceId, m3u8: null, referer: `${BASE}/` };
}
