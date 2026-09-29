import { prisma } from '../db/prisma';
import { sha256 } from '../utils/crypto';
import { businessRules } from './settings.service';
import { childLogger } from '../config/logger';

const log = childLogger('duplicate');

const HOUR_MS = 3_600_000;

export type DuplicateSeverity = 'NONE' | 'WARN' | 'REVIEW';

export interface DuplicateMatch {
  campaignId: string;
  campaignName: string;
  reason: string;
}

export interface DuplicateCampaignResult {
  isDuplicate: boolean;
  severity: DuplicateSeverity;
  matches: DuplicateMatch[];
}

const SEVERITY_RANK: Record<DuplicateSeverity, number> = { NONE: 0, WARN: 1, REVIEW: 2 };

/**
 * Normalised form used for ad-text fingerprints: lower-cased, whitespace
 * collapsed to single spaces, trimmed, then punctuation stripped (anything
 * that is not a letter, a number, or whitespace — Unicode-aware, so Bengali
 * and other non-Latin scripts are preserved). "50% OFF!!!" and "50 off"
 * therefore collide. A final whitespace pass keeps the digest stable after
 * stripping eats characters between words.
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Case/whitespace-insensitive comparison form for destination URLs. */
function normalizeDestination(url?: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

/**
 * Fingerprint a single creative.
 *
 * - `textHash`:  sha256 of the normalised text (see normalizeText).
 * - `imageHash`: sha256 of the image URL's lower-cased pathname, only when a
 *                parseable URL is supplied. Query strings and fragments are
 *                ignored, so re-uploads of the same file collide.
 */
export function fingerprintCreative(input: {
  text: string;
  imageUrl?: string | null;
}): { textHash: string; imageHash?: string } {
  const textHash = sha256(normalizeText(input.text));

  let imageHash: string | undefined;
  if (input.imageUrl) {
    try {
      imageHash = sha256(new URL(input.imageUrl).pathname.toLowerCase());
    } catch {
      // Not a parseable URL — no image fingerprint. Never throw on creative input.
    }
  }

  return imageHash === undefined ? { textHash } : { textHash, imageHash };
}

/**
 * Classify how "duplicate" a campaign-under-construction is, against every
 * non-house campaign created within the last `duplicate_ad_detection_hours`
 * window (all advertisers, because the cross-advertiser rule requires it).
 *
 * Rules (strongest severity wins; every matched campaign is reported):
 *   1. Same advertiser + same destination URL in the window          -> REVIEW
 *   2. Same advertiser + an identical textHash in the window          -> WARN
 *   3. Different advertiser + identical textHash AND identical
 *      destination URL in the window                                  -> REVIEW
 *
 * This function ONLY classifies — it never hard-blocks. The caller decides
 * whether to route the campaign to review.
 */
export async function detectDuplicateCampaign(input: {
  advertiserId: string;
  creatives: Array<{ text: string; imageUrl?: string | null }>;
  destinationUrl?: string | null;
  excludeCampaignId?: string;
}): Promise<DuplicateCampaignResult> {
  const hours = await businessRules.duplicateAdDetectionHours();
  const windowStart = new Date(Date.now() - hours * HOUR_MS);

  const inputTextHashes = new Set<string>();
  for (const creative of input.creatives) {
    inputTextHashes.add(fingerprintCreative(creative).textHash);
  }
  const inputDestination = normalizeDestination(input.destinationUrl);

  const candidates = await prisma.campaign.findMany({
    where: {
      createdAt: { gte: windowStart },
      isHouse: false,
      ...(input.excludeCampaignId ? { id: { not: input.excludeCampaignId } } : {}),
    },
    select: { id: true, name: true, advertiserId: true },
  });

  if (candidates.length === 0) {
    return { isDuplicate: false, severity: 'NONE', matches: [] };
  }

  // Read each candidate's active ad rows for stored textHash / destinationUrl.
  // Stored hashes win; fall back to recomputing from the raw text when the
  // row was created before hashing existed.
  const ads = await prisma.ad.findMany({
    where: { campaignId: { in: candidates.map((c) => c.id) }, isActive: true },
    select: { campaignId: true, text: true, textHash: true, destinationUrl: true },
  });

  const hashesByCampaign = new Map<string, Set<string>>();
  const destinationsByCampaign = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    hashesByCampaign.set(candidate.id, new Set<string>());
    destinationsByCampaign.set(candidate.id, new Set<string>());
  }
  for (const ad of ads) {
    const hashes = hashesByCampaign.get(ad.campaignId);
    const destinations = destinationsByCampaign.get(ad.campaignId);
    if (!hashes || !destinations) continue;
    hashes.add(ad.textHash ?? sha256(normalizeText(ad.text)));
    const destination = normalizeDestination(ad.destinationUrl);
    if (destination !== null) destinations.add(destination);
  }

  const matches: DuplicateMatch[] = [];
  let severity: DuplicateSeverity = 'NONE';

  for (const candidate of candidates) {
    const candidateHashes = hashesByCampaign.get(candidate.id) ?? new Set<string>();
    const candidateDestinations = destinationsByCampaign.get(candidate.id) ?? new Set<string>();
    const sameAdvertiser = candidate.advertiserId === input.advertiserId;

    const sharesText = [...candidateHashes].some((h) => inputTextHashes.has(h));
    const sharesDestination = inputDestination !== null && candidateDestinations.has(inputDestination);

    let candidateSeverity: DuplicateSeverity = 'NONE';
    let reason = '';

    if (sameAdvertiser) {
      if (sharesDestination) {
        candidateSeverity = 'REVIEW';
        reason = `your campaign "${candidate.name}" targets the same destination URL within the last ${hours} hours`;
      } else if (sharesText) {
        candidateSeverity = 'WARN';
        reason = `your campaign "${candidate.name}" uses identical ad text within the last ${hours} hours`;
      }
    } else if (sharesText && sharesDestination) {
      candidateSeverity = 'REVIEW';
      reason = `another advertiser's campaign "${candidate.name}" uses identical ad text and destination URL within the last ${hours} hours`;
    }

    if (candidateSeverity !== 'NONE') {
      matches.push({ campaignId: candidate.id, campaignName: candidate.name, reason });
      if (SEVERITY_RANK[candidateSeverity] > SEVERITY_RANK[severity]) {
        severity = candidateSeverity;
      }
    }
  }

  if (severity !== 'NONE') {
    log.warn(
      { advertiserId: input.advertiserId, severity, matchCount: matches.length },
      'duplicate campaign detected',
    );
  }

  return { isDuplicate: matches.length > 0, severity, matches };
}

/**
 * Fingerprint summary for one campaign (active ads only): every distinct
 * text hash and every distinct destination URL it carries.
 */
export async function campaignFingerprints(
  campaignId: string,
): Promise<{ textHashes: string[]; destinations: string[] }> {
  const ads = await prisma.ad.findMany({
    where: { campaignId, isActive: true },
    select: { text: true, textHash: true, destinationUrl: true },
  });

  const textHashes: string[] = [];
  const destinations: string[] = [];
  const seenHashes = new Set<string>();
  const seenDestinations = new Set<string>();

  for (const ad of ads) {
    const hash = ad.textHash ?? sha256(normalizeText(ad.text));
    if (!seenHashes.has(hash)) {
      seenHashes.add(hash);
      textHashes.push(hash);
    }
    const destination = ad.destinationUrl?.trim() ?? '';
    if (destination && !seenDestinations.has(destination)) {
      seenDestinations.add(destination);
      destinations.push(destination);
    }
  }

  return { textHashes, destinations };
}
