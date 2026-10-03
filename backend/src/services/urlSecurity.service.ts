import { createHash } from 'crypto';
import dns from 'node:dns/promises';
import axios from 'axios';
import { prisma } from '../db/prisma';
import { cacheGet, cacheSet } from '../db/redis';
import { logger } from '../config/logger';
import { NotFoundError, ValidationError } from '../utils/errors';
import { getPagination, paginate, type Pagination } from '../utils/pagination';
import { recordAudit } from './audit.service';

/**
 * Destination-URL security validation.
 *
 * Every campaign destination URL is screened here BEFORE the campaign is
 * accepted, so a known-bad link (blocked domain, shortener, redirect chain
 * into a different registrable domain, `javascript:`/`data:` payloads, ...)
 * never reaches a publisher channel.
 *
 * Design rules:
 *  - `validateDestinationUrl` NEVER throws — a crash here would block
 *    legitimate campaign creation. Unexpected errors degrade to a
 *    review-only flag, never to a hard block.
 *  - Hard blocks are reserved for objective technical facts (bad scheme,
 *    plain HTTP, invalid host, admin-blocked domain, redirect storm).
 *  - Anything ambiguous (punycode, deep labels, shortener-ish TLDs, network
 *    failures, cross-domain redirects) is a *review* reason: `ok` stays
 *    `true` and the caller decides whether `reasons.length > 0` routes the
 *    campaign to manual review.
 */

export interface UrlValidationResult {
  /** `true` unless the URL is hard-blocked. Review reasons do NOT flip this. */
  ok: boolean;
  /** `true` when the URL must be rejected outright. */
  hardBlock: boolean;
  /** Every failed reason, collected (never early-return). May be empty. */
  reasons: string[];
  /** Final HTTPS URL after following the redirect chain. */
  normalized?: string;
  /** Registrable parent domain of the final host (last two labels). */
  domain?: string;
}

const MAX_REDIRECT_HOPS = 5;
const CACHE_TTL_SECONDS = 3600;
const HTTP_TIMEOUT_MS = 5000;
/** TLDs that masquerade as Telegram/file shares — classic scam pattern. */
const SUSPICIOUS_TLDS = new Set(['zip', 'mov', 'review', 'country']);

type HardReason = (reason: string) => void;
type ReviewReason = (reason: string) => void;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** True for IPv4 (`1.2.3.4`) or IPv6 (`::1`) literals. */
function isIpLiteral(host: string): boolean {
  if (host.includes(':')) return true; // IPv6 (URL hostname already unbracketed)
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every(
    (p) => p.length > 0 && p.length <= 3 && /^\d+$/.test(p) && Number(p) <= 255,
  );
}

/** True for RFC1918 / loopback / link-local / CGNAT IPv4 literals. */
function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, 127/8
  if (a === 169 && b === 254) return true; // link-local 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

/**
 * True for loopback / private / link-local / CGNAT destinations — the hosts a
 * server-side outbound request must never be allowed to reach. Shared by the
 * destination-URL checker and the advertiser-webhook delivery path (SSRF guard).
 */
export function isPrivateOrInternalHost(host: string): boolean {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;

  if (h.includes(':')) {
    if (h === '::' || h === '::1') return true; // unspecified / loopback
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // link-local fe80::/10
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // unique-local fc00::/7
    const mapped = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/); // IPv4-mapped
    if (mapped && isPrivateIpv4(mapped[1])) return true;
    return false;
  }

  return isPrivateIpv4(h);
}

/**
 * What a hostname currently resolves to, and whether that is safe to dial.
 *
 * The literal-host checks above can only judge what was typed. A public name that
 * resolves into the private network — attacker-controlled DNS, or a name that simply
 * points inward — passes every one of them, and the outbound request then reaches
 * something it must never reach. This is the check that has to happen before the
 * connection, not before the string.
 *
 * `unresolved` is deliberately distinct from `internal`: a name that cannot be resolved
 * is unverifiable (the request would fail on its own), while a name that resolves inward
 * is a refusal. The first must never hard-block a legitimate advertiser whose DNS is
 * having a bad minute; the second must never be fetched at all.
 */
export type HostAddressCheck =
  | { ok: true; addresses: string[] }
  | { ok: false; reason: 'internal'; addresses: string[] }
  | { ok: false; reason: 'unresolved'; addresses: [] };

export async function resolveHostAddresses(hostname: string): Promise<HostAddressCheck> {
  const host = String(hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');

  if (!host) return { ok: false, reason: 'unresolved', addresses: [] };
  if (isPrivateOrInternalHost(host)) return { ok: false, reason: 'internal', addresses: [] };
  // An IP literal needs no round trip and every address it yields is itself.
  if (isIpLiteral(host)) return { ok: true, addresses: [host] };

  let records: { address: string; family: number }[];
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    logger.warn({ err: (err as Error).message, host }, 'destination could not be resolved');
    return { ok: false, reason: 'unresolved', addresses: [] };
  }
  if (records.length === 0) return { ok: false, reason: 'unresolved', addresses: [] };

  const addresses = records.map((r) => r.address);
  // EVERY answer has to be public. Accepting the set because one member is public would
  // leave the request free to be pinned — or re-resolved — onto the private member.
  if (addresses.some((a) => isPrivateOrInternalHost(a))) {
    return { ok: false, reason: 'internal', addresses };
  }
  return { ok: true, addresses };
}

/**
 * A `lookup` that can only hand back the addresses already vetted above.
 *
 * Validating and then connecting separately leaves the gap a rebinding resolver needs:
 * the name is public when it is checked and private when it is dialled. Pinning the
 * vetted answers to the request closes that window rather than narrowing it.
 */
export type PinnedLookup = (
  hostname: string,
  options: object,
  callback: (err: Error | null, address?: unknown, family?: number) => void,
) => void;

/**
 * axios declares `lookup` against its own `LookupAddress`, which is structurally this
 * but nominally different (its `family` is a narrower union). Declaring the shape here
 * and crossing at the boundary once keeps the assignment local instead of duplicating
 * axios's private types.
 */
type AxiosLookupOption = NonNullable<Parameters<typeof axios.head>[1]>['lookup'];

export function pinnedLookup(addresses: string[]): PinnedLookup {
  const familyOf = (address: string): number => (address.includes(':') ? 6 : 4);
  return (_hostname, options, callback) => {
    const first = addresses[0];
    if (!first) {
      callback(new Error('no vetted address to connect to'));
      return;
    }
    // Node calls `lookup(hostname, options, cb)`. The two-argument form is
    // `dns.lookup`'s own (hostname, cb) shorthand, which some agents use.
    if (typeof options === 'function') {
      (options as (err: Error | null, address: string, family: number) => void)(null, first, familyOf(first));
      return;
    }
    if ((options as { all?: boolean }).all) {
      callback(
        null,
        addresses.map((address) => ({ address, family: familyOf(address) })),
      );
      return;
    }
    callback(null, first, familyOf(first));
  };
}

/**
 * Canonical domain form used everywhere: lowercased, no scheme/path/port,
 * no leading `www.`, reduced to the registrable parent (last two labels).
 * `https://www.Sub.Example.com:8443/x?y` -> `example.com`
 */
export function normaliseDomain(input: string): string {
  let s = String(input ?? '').trim().toLowerCase();
  if (!s) return '';
  // Strip a URL scheme (http://, https://, ftp://, ...).
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  // Strip path / query / hash.
  const cut = s.search(/[/?#]/);
  if (cut !== -1) s = s.slice(0, cut);
  // Strip userinfo (user:pass@host).
  const at = s.lastIndexOf('@');
  if (at !== -1) s = s.slice(at + 1);
  // Strip an explicit port, e.g. `example.com:8443` or `[::1]:8080`.
  const portMatch = s.match(/^(.*):(\d{1,5})$/);
  if (portMatch) {
    const head = portMatch[1];
    const bracketedIpv6 = head.startsWith('[') && head.endsWith(']');
    // A bare IPv6 literal also matches (`::1` -> head `:`), so only strip
    // when the head is a plain name or a bracketed IPv6 address.
    if (bracketedIpv6 || !head.includes(':')) s = head;
  }
  // Strip IPv6 brackets if still present.
  s = s.replace(/^\[(.*)\]$/, '$1');
  // Strip leading `www.`.
  if (s.startsWith('www.')) s = s.slice(4);
  // Strip a trailing dot.
  if (s.endsWith('.')) s = s.slice(0, -1);
  const labels = s.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  return labels.slice(-2).join('.');
}

/** Registrable parent (last two labels) of a bare hostname. */
function registrableParent(host: string): string {
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  return labels.slice(-2).join('.');
}

/** Extract the registrable domain from a URL, or `null` if unparseable/IP. */
export function extractDomainFromUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!host || isIpLiteral(host)) return null;
  return normaliseDomain(host);
}

/**
 * Step 1–4 (pure, synchronous) checks on a parsed URL.
 * Collects every failed reason — never returns early.
 */
function evaluateUrlRules(u: URL, hard: HardReason, review: ReviewReason): void {
  // 1. Scheme.
  const isHttp = u.protocol === 'http:';
  const isHttps = u.protocol === 'https:';
  if (!isHttp && !isHttps) {
    hard('unsupported URL scheme');
    return; // javascript:/data:/file:/ftp:/... have no host to inspect
  }
  // 2. HTTPS only.
  if (isHttp) hard('only HTTPS links are allowed');

  const host = u.hostname.toLowerCase();
  if (!host) return;

  // 3. Host sanity (hard blocks).
  if (
    !host.includes('.') ||
    isIpLiteral(host) ||
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    hard('invalid host');
  }

  // 4. Review-only heuristics.
  const labels = host.split('.');
  if (labels.some((l) => l.startsWith('xn--'))) review('punycode-encoded hostname');
  if (host.length > 253 || labels.some((l) => l.length > 63)) {
    review('excessive hostname length');
  }
  if (labels.length > 5) review('excessive subdomain depth');
  const tld = labels[labels.length - 1];
  if (tld && SUSPICIOUS_TLDS.has(tld)) review('suspicious file-like TLD');
  if (u.username !== '' || u.password !== '') review('URL contains embedded credentials');
  if (isHttps && u.port !== '' && u.port !== '443') review('URL uses a non-default port');
}

/**
 * Step 5: blocked-domain lookup on the host AND its registrable parent.
 * A DB failure degrades to a review reason — never a hard block.
 */
async function evaluateBlockedDomains(host: string, hard: HardReason, review: ReviewReason): Promise<void> {
  const candidates = Array.from(new Set([host, registrableParent(host)].filter(Boolean)));
  if (candidates.length === 0) return;
  let rows;
  try {
    rows = await prisma.blockedDomain.findMany({ where: { domain: { in: candidates } } });
  } catch (err) {
    logger.warn({ err: err as Error, candidates }, 'blocked-domain lookup failed');
    review('destination could not be verified');
    return;
  }
  for (const row of rows) {
    if (row.hardBlock) hard('this domain is blocked');
    else review('this domain is flagged for review');
  }
}

/**
 * Step 6: follow the redirect chain (max 5 hops). Each hop's host is
 * re-validated through steps 1–5. Network failures are review reasons only.
 * Returns the final URL of the chain.
 */
async function followRedirectChain(
  start: URL,
  hard: HardReason,
  review: ReviewReason,
  isHardBlocked: () => boolean,
): Promise<URL> {
  const firstParent = registrableParent(start.hostname.toLowerCase());
  let current = start;

  for (let hop = 1; hop <= MAX_REDIRECT_HOPS; hop++) {
    // Resolve THIS hop before dialling it, and hand the request the vetted addresses so
    // it cannot be pointed somewhere else between the check and the connection.
    const resolution = await resolveHostAddresses(current.hostname);
    if (!resolution.ok) {
      if (resolution.reason === 'internal') {
        hard('destination resolves to a private, loopback, link-local or internal address');
        // Already hard-blocked: do not complete this hop's request.
        return current;
      }
      // Unresolvable is merely unverifiable — same treatment as any other network
      // failure above, and never a hard block.
      review('destination could not be resolved');
      return current;
    }

    let location: string | undefined;
    try {
      const res = await axios.head(current.toString(), {
        maxRedirects: 0,
        timeout: HTTP_TIMEOUT_MS,
        validateStatus: () => true,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BotFlowLinkCheck/1.0)' },
        lookup: pinnedLookup(resolution.addresses) as AxiosLookupOption,
      });
      const loc = res.headers?.location;
      const isRedirect = res.status >= 300 && res.status < 400;
      if (isRedirect) {
        location = Array.isArray(loc) ? loc[0] : typeof loc === 'string' ? loc : undefined;
      }
    } catch (err) {
      // Timeout, DNS failure, connection refused, TLS error — the destination
      // is merely UNVERIFIABLE. Never hard-block on a network failure.
      logger.warn(
        { err: (err as Error).message, url: current.toString() },
        'destination could not be verified (network failure)',
      );
      review('destination could not be verified');
      return current;
    }

    if (!location) return current; // final hop reached (2xx/4xx/5xx or no location)

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      logger.warn({ location, url: current.toString() }, 'malformed redirect location');
      review('destination could not be verified');
      return current;
    }

    // Re-validate this hop through steps 1–5.
    evaluateUrlRules(next, hard, review);
    await evaluateBlockedDomains(next.hostname.toLowerCase(), hard, review);

    // A hard-blocked hop (internal IP, localhost, non-HTTPS, blocked domain)
    // must NEVER be fetched — abort the chain here instead of completing the
    // next loop iteration's request against the blocked destination (SSRF).
    if (isHardBlocked()) return current;

    const nextParent = registrableParent(next.hostname.toLowerCase());
    if (nextParent && firstParent && nextParent !== firstParent) {
      review('redirects to a different domain');
    }
    current = next;
  }

  // Still redirecting after MAX_REDIRECT_HOPS hops.
  hard('too many redirects');
  return current;
}

/** Stable cache key: sha256 of the URL in normalised form. */
function urlCacheKey(rawUrl: string): string {
  const trimmed = String(rawUrl ?? '').trim();
  let normalised = trimmed;
  try {
    const u = new URL(trimmed);
    u.hash = '';
    if (u.protocol === 'https:' && u.port === '443') u.port = '';
    if (u.protocol === 'http:' && u.port === '80') u.port = '';
    normalised = u.toString();
  } catch {
    // Unparseable — key off the raw trimmed string.
  }
  return `urlcheck:${sha256(normalised)}`;
}

/**
 * Full destination-URL security validation. NEVER throws: any unexpected
 * error degrades to `ok: true` + a review reason so campaign creation is
 * never blocked by a bug in the checker.
 */
export async function validateDestinationUrl(rawUrl: string): Promise<UrlValidationResult> {
  try {
    return await runValidation(rawUrl);
  } catch (err) {
    logger.warn({ err: err as Error, url: rawUrl }, 'validateDestinationUrl failed unexpectedly');
    return { ok: true, hardBlock: false, reasons: ['destination could not be verified'] };
  }
}

async function runValidation(rawUrl: string): Promise<UrlValidationResult> {
  // Redis cache: a repeat validation of the same URL must not re-fetch.
  const cacheKey = urlCacheKey(rawUrl);
  try {
    const cached = await cacheGet<UrlValidationResult>(cacheKey);
    if (
      cached &&
      typeof cached === 'object' &&
      typeof cached.ok === 'boolean' &&
      typeof cached.hardBlock === 'boolean' &&
      Array.isArray(cached.reasons)
    ) {
      return cached;
    }
  } catch (err) {
    logger.warn({ err: err as Error }, 'urlcheck cache read failed');
  }

  const reasons: string[] = [];
  let hardBlock = false;
  const hard: HardReason = (r) => {
    hardBlock = true;
    if (!reasons.includes(r)) reasons.push(r);
  };
  const review: ReviewReason = (r) => {
    if (!reasons.includes(r)) reasons.push(r);
  };

  // Step 1: must parse.
  let finalUrl: URL | undefined;
  try {
    finalUrl = new URL(rawUrl);
  } catch {
    hard('unsupported URL scheme');
    return finish(finalUrl, reasons, hardBlock, cacheKey);
  }

  const u = finalUrl;
  // Steps 1–4 (scheme / https / host sanity / heuristics).
  evaluateUrlRules(u, hard, review);
  // Step 5 (blocked-domain lookup on host + registrable parent).
  if (u.hostname) await evaluateBlockedDomains(u.hostname.toLowerCase(), hard, review);

  // Step 6 (redirect chain) — only when not already hard-blocked and the
  // URL is actually fetchable (https with a hostname).
  if (!hardBlock && u.protocol === 'https:' && u.hostname && !isIpLiteral(u.hostname.toLowerCase())) {
    finalUrl = await followRedirectChain(u, hard, review, () => hardBlock);
  }

  return finish(finalUrl, reasons, hardBlock, cacheKey);
}

async function finish(
  finalUrl: URL | undefined,
  reasons: string[],
  hardBlock: boolean,
  cacheKey: string,
): Promise<UrlValidationResult> {
  const finalHost = finalUrl?.hostname.toLowerCase() ?? '';
  const domain = finalHost && !isIpLiteral(finalHost) ? registrableParent(finalHost) : '';
  const result: UrlValidationResult = {
    ok: !hardBlock,
    hardBlock,
    reasons,
    ...(finalUrl ? { normalized: finalUrl.toString() } : {}),
    ...(domain ? { domain } : {}),
  };

  // Cache the final result for 3600s so a repeat does not re-fetch.
  try {
    await cacheSet(cacheKey, result, CACHE_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err: err as Error, key: cacheKey }, 'urlcheck cache write failed');
  }

  return result;
}

/**
 * Direct admin/lookup helper: is a (registrable) domain in the blocked list?
 * `blocked` = a row exists; `hardBlock` = it must be rejected outright
 * (false means "flagged for review").
 */
export async function isDomainBlocked(
  domain: string,
): Promise<{ blocked: boolean; hardBlock: boolean; reason?: string }> {
  const d = normaliseDomain(domain);
  if (!d) return { blocked: false, hardBlock: false };
  const row = await prisma.blockedDomain.findUnique({ where: { domain: d } });
  if (!row) return { blocked: false, hardBlock: false };
  return { blocked: true, hardBlock: row.hardBlock, reason: row.reason ?? undefined };
}

/** Paginated list of blocked/flagged domains (newest first). */
export async function listBlockedDomains(p?: Pagination): Promise<unknown> {
  const page = p ?? getPagination();
  return paginate(
    page,
    () => prisma.blockedDomain.count(),
    ({ skip, take }) =>
      prisma.blockedDomain.findMany({
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: { channel: { select: { id: true, username: true } } },
      }),
  );
}

/**
 * Add (or update) a blocked/flagged domain. The domain is normalised to its
 * registrable parent, then upserted, then audited.
 */
export async function addBlockedDomain(
  input: { domain: string; reason?: string; hardBlock?: boolean; channelId?: string | null },
  adminId?: string,
): Promise<unknown> {
  const domain = normaliseDomain(input.domain);
  if (!domain) throw new ValidationError('A valid domain is required');

  const update: { reason?: string | null; hardBlock?: boolean; channelId?: string | null } = {};
  if (input.reason !== undefined) update.reason = input.reason;
  if (input.hardBlock !== undefined) update.hardBlock = input.hardBlock;
  if (input.channelId !== undefined) update.channelId = input.channelId;

  const row = await prisma.blockedDomain.upsert({
    where: { domain },
    create: {
      domain,
      reason: input.reason ?? null,
      hardBlock: input.hardBlock ?? true,
      channelId: input.channelId ?? null,
      createdById: adminId ?? null,
    },
    update,
  });

  await recordAudit({
    actorId: adminId ?? null,
    actorType: 'ADMIN',
    action: 'BLOCKED_DOMAIN_ADDED',
    targetType: 'BLOCKED_DOMAIN',
    targetId: row.id,
    newValue: {
      domain: row.domain,
      hardBlock: row.hardBlock,
      reason: row.reason,
      channelId: row.channelId,
    },
  });

  return row;
}

/** Remove a blocked-domain row and audit the removal. */
export async function removeBlockedDomain(id: string, adminId?: string): Promise<void> {
  const existing = await prisma.blockedDomain.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Blocked domain not found');

  await prisma.blockedDomain.delete({ where: { id } });

  await recordAudit({
    actorId: adminId ?? null,
    actorType: 'ADMIN',
    action: 'BLOCKED_DOMAIN_REMOVED',
    targetType: 'BLOCKED_DOMAIN',
    targetId: id,
    oldValue: {
      domain: existing.domain,
      hardBlock: existing.hardBlock,
      reason: existing.reason,
      channelId: existing.channelId,
    },
  });
}

/**
 * Shorteners are legitimate but they hide the real destination, so they are
 * seeded as review flags (hardBlock: false), not hard blocks. Idempotent —
 * returns how many rows were created on this call.
 */
const DEFAULT_SOFT_BLOCKED_DOMAINS = ['bit.ly', 'tinyurl.com', 't.co'];

export async function seedDefaultBlockedDomains(): Promise<number> {
  let created = 0;
  for (const domain of DEFAULT_SOFT_BLOCKED_DOMAINS) {
    const existing = await prisma.blockedDomain.findUnique({ where: { domain } });
    if (existing) continue;
    try {
      await prisma.blockedDomain.create({
        data: {
          domain,
          reason: 'URL shortener hides the destination - route campaign to review',
          hardBlock: false,
        },
      });
      created++;
    } catch (err) {
      // Concurrent seed raced us on the unique `domain` — that is fine.
      if ((err as { code?: unknown })?.code === 'P2002') continue;
      throw err;
    }
  }
  return created;
}
