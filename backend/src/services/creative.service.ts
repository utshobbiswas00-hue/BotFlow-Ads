import type { AdFormat } from '@prisma/client';
import { prisma, transaction, Prisma } from '../db/prisma';
import { sha256 } from '../utils/crypto';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../utils/errors';
import { childLogger } from '../config/logger';

const log = childLogger('creative');

/* ------------------------------------------------------------------ */
/*  Content fingerprints                                               */
/*  Identical normalisation to the duplicate-advertisement detector so */
/*  hashes produced here compare equal to hashes produced there.       */
/* ------------------------------------------------------------------ */

/** Lower-case, strip punctuation, collapse whitespace → sha256. */
function textHash(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return sha256(normalized);
}

/** sha256 of the image URL's pathname (query strings / CDN params ignored). */
function imageHash(imageUrl: string | null | undefined): string | null {
  if (!imageUrl) return null;
  let pathname: string;
  try {
    pathname = new URL(imageUrl).pathname;
  } catch {
    pathname = imageUrl.trim();
  }
  return sha256(pathname);
}

/* ------------------------------------------------------------------ */
/*  Versioned creative editing                                         */
/* ------------------------------------------------------------------ */

/**
 * Write the initial set of AdCreativeVersion rows for an ad (version 1..n,
 * all DRAFT) and set the ad's content fingerprints. Intended to run inside
 * the campaign-creation transaction.
 */
export async function createCreativeVersions(
  tx: Prisma.TransactionClient,
  input: {
    adId: string;
    creatives: Array<{
      format?: AdFormat;
      text: string;
      imageUrl?: string | null;
      buttonText?: string | null;
      buttonUrl?: string | null;
      destinationUrl?: string | null;
    }>;
    actorId?: string | null;
  },
): Promise<number> {
  const { adId, creatives, actorId } = input;
  if (!adId) throw new ValidationError('adId is required');
  if (!Array.isArray(creatives) || creatives.length === 0) {
    throw new ValidationError('At least one creative is required');
  }

  const ad = await tx.ad.findUnique({ where: { id: adId } });
  if (!ad) throw new NotFoundError('Ad');

  const versions = creatives.map((creative, index) => {
    if (!creative.text || creative.text.trim().length === 0) {
      throw new ValidationError(`Creative #${index + 1}: text is required`);
    }
    return {
      adId,
      version: index + 1,
      status: 'DRAFT' as const,
      format: creative.format ?? ('TEXT' as AdFormat),
      text: creative.text,
      imageUrl: creative.imageUrl ?? null,
      buttonText: creative.buttonText ?? null,
      buttonUrl: creative.buttonUrl ?? null,
      destinationUrl: creative.destinationUrl ?? null,
      requiresReview: false,
      changeNote: null,
    };
  });

  for (const version of versions) {
    await tx.adCreativeVersion.create({ data: version });
  }

  // Fingerprints follow the first creative — the ad's live content.
  const first = creatives[0];
  await tx.ad.update({
    where: { id: adId },
    data: {
      textHash: textHash(first.text),
      imageHash: imageHash(first.imageUrl),
    },
  });

  log.info(
    { adId, count: versions.length, actorId: actorId ?? null },
    'creative versions created',
  );
  return versions.length;
}

/** Every version of an ad, newest first. */
export async function listCreativeVersions(adId: string): Promise<unknown> {
  const ad = await prisma.ad.findUnique({ where: { id: adId } });
  if (!ad) throw new NotFoundError('Ad');
  return prisma.adCreativeVersion.findMany({
    where: { adId },
    orderBy: { version: 'desc' },
  });
}

/**
 * Edit an ad's creative without ever mutating an existing version row.
 *
 * - Draft / in-review campaign: the Ad row is updated in place AND a new
 *   DRAFT version is appended (history is never lost). No re-review needed.
 * - Approved / scheduled / running / paused campaign: a NEW version is
 *   appended with requiresReview=true and status PENDING_REVIEW; all older
 *   versions are ARCHIVED and Ad.version is incremented. The live Ad row
 *   keeps serving the already-approved content until the admin approves the
 *   new version.
 */
export async function updateCreative(
  advertiserId: string,
  adId: string,
  input: {
    text?: string;
    imageUrl?: string | null;
    buttonText?: string | null;
    buttonUrl?: string | null;
    destinationUrl?: string | null;
    changeNote?: string;
  },
): Promise<{ adId: string; newVersion: number; requiresReview: boolean }> {
  if (!advertiserId) throw new ValidationError('advertiserId is required');
  if (input.text !== undefined && input.text.trim().length === 0) {
    throw new ValidationError('text cannot be empty');
  }

  return transaction(async (tx) => {
    const ad = await tx.ad.findUnique({
      where: { id: adId },
      include: { campaign: true },
    });
    if (!ad) throw new NotFoundError('Ad');
    if (ad.campaign.advertiserId !== advertiserId) {
      throw new ForbiddenError('You can only update creatives of your own campaigns');
    }

    // Merge incoming changes over the currently live content.
    const nextText = input.text !== undefined ? input.text : ad.text;
    const nextImageUrl = input.imageUrl !== undefined ? input.imageUrl : ad.imageUrl;
    const nextButtonText = input.buttonText !== undefined ? input.buttonText : ad.buttonText;
    const nextButtonUrl = input.buttonUrl !== undefined ? input.buttonUrl : ad.buttonUrl;
    const nextDestinationUrl =
      input.destinationUrl !== undefined ? input.destinationUrl : ad.destinationUrl;

    const maxRow = await tx.adCreativeVersion.aggregate({
      where: { adId },
      _max: { version: true },
    });
    const newVersion = (maxRow._max.version ?? 0) + 1;

    const campaignStatus = ad.campaign.status;

    if (campaignStatus === 'DRAFT' || campaignStatus === 'PENDING_REVIEW') {
      // Nothing has been approved yet: edit the live row in place and append
      // a DRAFT snapshot so the old content is preserved in history.
      await tx.ad.update({
        where: { id: adId },
        data: {
          text: nextText,
          imageUrl: nextImageUrl,
          buttonText: nextButtonText,
          buttonUrl: nextButtonUrl,
          destinationUrl: nextDestinationUrl,
          textHash: textHash(nextText),
          imageHash: imageHash(nextImageUrl),
        },
      });
      await tx.adCreativeVersion.create({
        data: {
          adId,
          version: newVersion,
          status: 'DRAFT',
          format: ad.format,
          text: nextText,
          imageUrl: nextImageUrl,
          buttonText: nextButtonText,
          buttonUrl: nextButtonUrl,
          destinationUrl: nextDestinationUrl,
          requiresReview: false,
          changeNote: input.changeNote ?? null,
        },
      });
      return { adId, newVersion, requiresReview: false };
    }

    if (
      campaignStatus === 'APPROVED' ||
      campaignStatus === 'SCHEDULED' ||
      campaignStatus === 'RUNNING' ||
      campaignStatus === 'PAUSED'
    ) {
      // Live campaign: the approved content keeps serving untouched. The
      // change is captured as a new version that must be re-reviewed.
      await tx.adCreativeVersion.create({
        data: {
          adId,
          version: newVersion,
          status: 'PENDING_REVIEW',
          format: ad.format,
          text: nextText,
          imageUrl: nextImageUrl,
          buttonText: nextButtonText,
          buttonUrl: nextButtonUrl,
          destinationUrl: nextDestinationUrl,
          requiresReview: true,
          changeNote: input.changeNote ?? null,
        },
      });
      await tx.adCreativeVersion.updateMany({
        where: { adId, version: { lt: newVersion } },
        data: { status: 'ARCHIVED' },
      });
      // Bump the version counter only — do NOT change the Ad's content.
      await tx.ad.update({
        where: { id: adId },
        data: { version: { increment: 1 } },
      });
      return { adId, newVersion, requiresReview: true };
    }

    throw new ConflictError(
      'Creatives can only be changed while the campaign is in review or live',
    );
  });
}

/**
 * Admin review of a pending creative version.
 * APPROVE promotes the version's content onto the live Ad row (and its
 * fingerprints) and clears requiresReview. REJECT only closes the version —
 * the Ad keeps serving the last approved content.
 */
export async function reviewCreativeVersion(
  adminId: string,
  versionId: string,
  action: 'APPROVE' | 'REJECT',
  note?: string,
): Promise<void> {
  if (!adminId) throw new ValidationError('adminId is required');
  if (action !== 'APPROVE' && action !== 'REJECT') {
    throw new ValidationError('action must be APPROVE or REJECT');
  }

  const version = await prisma.adCreativeVersion.findUnique({
    where: { id: versionId },
  });
  if (!version) throw new NotFoundError('Creative version');
  if (version.status !== 'PENDING_REVIEW') {
    throw new ConflictError(
      `Version ${version.version} is not pending review (current status: ${version.status})`,
    );
  }

  const reviewedAt = new Date();

  await transaction(async (tx) => {
    if (action === 'APPROVE') {
      await tx.adCreativeVersion.update({
        where: { id: versionId },
        data: {
          status: 'APPROVED',
          requiresReview: false,
          reviewedById: adminId,
          reviewedAt,
          reviewNote: note ?? null,
        },
      });
      // Promote the approved content onto the live Ad row.
      await tx.ad.update({
        where: { id: version.adId },
        data: {
          text: version.text,
          imageUrl: version.imageUrl,
          buttonText: version.buttonText,
          buttonUrl: version.buttonUrl,
          destinationUrl: version.destinationUrl,
          textHash: textHash(version.text),
          imageHash: imageHash(version.imageUrl),
          version: version.version,
        },
      });
    } else {
      // The Ad keeps serving the last approved content — no Ad update.
      await tx.adCreativeVersion.update({
        where: { id: versionId },
        data: {
          status: 'REJECTED',
          requiresReview: false,
          reviewedById: adminId,
          reviewedAt,
          reviewNote: note ?? null,
        },
      });
    }
  });

  log.info({ adminId, versionId, adId: version.adId, action }, 'creative version reviewed');
}

/**
 * All versions waiting on admin review (requiresReview + PENDING_REVIEW),
 * newest first, joined with the ad, campaign name and advertiser name.
 */
export async function pendingReviewVersions(): Promise<unknown> {
  const versions = await prisma.adCreativeVersion.findMany({
    where: { requiresReview: true, status: 'PENDING_REVIEW' },
    orderBy: { createdAt: 'desc' },
    include: {
      ad: {
        select: {
          id: true,
          trackingSlug: true,
          campaign: {
            select: {
              id: true,
              name: true,
              advertiser: {
                select: { id: true, firstName: true, lastName: true, username: true },
              },
            },
          },
        },
      },
    },
  });

  return versions.map((version) => {
    const advertiser = version.ad.campaign.advertiser;
    const advertiserName =
      [advertiser.firstName, advertiser.lastName]
        .filter((part): part is string => Boolean(part && part.trim().length > 0))
        .join(' ') || advertiser.username || 'Advertiser';

    return {
      id: version.id,
      adId: version.adId,
      version: version.version,
      status: version.status,
      format: version.format,
      text: version.text,
      imageUrl: version.imageUrl,
      buttonText: version.buttonText,
      buttonUrl: version.buttonUrl,
      destinationUrl: version.destinationUrl,
      changeNote: version.changeNote,
      createdAt: version.createdAt,
      ad: {
        id: version.ad.id,
        trackingSlug: version.ad.trackingSlug,
        campaign: {
          id: version.ad.campaign.id,
          name: version.ad.campaign.name,
          advertiser: { id: advertiser.id, name: advertiserName },
        },
      },
    };
  });
}
