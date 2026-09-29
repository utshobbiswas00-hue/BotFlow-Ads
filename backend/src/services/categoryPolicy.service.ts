/**
 * Platform category policy service.
 *
 * A global, per-advertising-category rule set: ALLOWED / REVIEW_REQUIRED /
 * BLOCKED. Categories without an explicit rule default to ALLOWED.
 *
 * Every BLOCKED / REVIEW_REQUIRED outcome carries a human-readable message —
 * the platform never rejects a campaign without telling the advertiser why.
 */
import { CategoryPolicy, ChannelCategory } from '@prisma/client';
import { prisma } from '../db/prisma';
import { recordAudit } from './audit.service';

const ALL_CATEGORIES: readonly ChannelCategory[] = Object.values(ChannelCategory);

function isChannelCategory(value: string): value is ChannelCategory {
  return (ALL_CATEGORIES as readonly string[]).includes(value);
}

/** Resolve the policy for one category. Unknown / unset categories are ALLOWED. */
export async function getCategoryPolicy(category: string): Promise<CategoryPolicy> {
  const key = category.trim().toUpperCase();
  if (!isChannelCategory(key)) return 'ALLOWED';

  const rule = await prisma.categoryPolicyRule.findUnique({ where: { category: key } });
  return rule?.policy ?? 'ALLOWED';
}

/**
 * Evaluate a campaign's advertising category against platform policy.
 * Used at campaign creation / approval so rejections always come with a
 * message the advertiser can understand.
 */
export async function evaluateCampaignCategory(
  category: string | null | undefined,
): Promise<{
  policy: CategoryPolicy;
  requiresReview: boolean;
  blocked: boolean;
  message?: string;
}> {
  if (!category || !category.trim()) {
    return { policy: 'ALLOWED', requiresReview: false, blocked: false };
  }

  const policy = await getCategoryPolicy(category);

  switch (policy) {
    case 'BLOCKED':
      return {
        policy: 'BLOCKED',
        blocked: true,
        requiresReview: false,
        message: 'This advertising category is not accepted on BotFlow Ads.',
      };
    case 'REVIEW_REQUIRED':
      return {
        policy: 'REVIEW_REQUIRED',
        blocked: false,
        requiresReview: true,
        message: 'This category is reviewed before delivery.',
      };
    case 'ALLOWED':
    default:
      return { policy: 'ALLOWED', blocked: false, requiresReview: false };
  }
}

/** Set (or create) the policy for a category. Audits old -> new value. */
export async function setCategoryPolicy(
  category: ChannelCategory,
  policy: CategoryPolicy,
  note?: string,
  adminId?: string,
): Promise<unknown> {
  const existing = await prisma.categoryPolicyRule.findUnique({ where: { category } });

  const rule = await prisma.categoryPolicyRule.upsert({
    where: { category },
    update: {
      policy,
      note: note ?? null,
      ...(adminId ? { updatedById: adminId } : {}),
    },
    create: {
      category,
      policy,
      note: note ?? null,
      updatedById: adminId ?? null,
    },
  });

  await recordAudit({
    actorId: adminId ?? null,
    actorType: 'ADMIN',
    action: 'CATEGORY_POLICY_CHANGED',
    targetType: 'CATEGORY_POLICY',
    targetId: category,
    oldValue: existing ? { policy: existing.policy, note: existing.note } : null,
    newValue: { policy, note: note ?? null },
  });

  return rule;
}

/**
 * Full policy table: every ChannelCategory joined with its rule (or the
 * implicit ALLOWED default when unset) so the admin UI can render the whole
 * list without a second fetch.
 */
export async function listCategoryPolicies(): Promise<unknown> {
  const rules = await prisma.categoryPolicyRule.findMany();
  const byCategory = new Map<string, (typeof rules)[number]>(rules.map((r) => [r.category, r]));

  return ALL_CATEGORIES.map((category) => {
    const rule = byCategory.get(category);
    return {
      category,
      policy: rule?.policy ?? 'ALLOWED',
      note: rule?.note ?? null,
      updatedById: rule?.updatedById ?? null,
      updatedAt: rule?.updatedAt ?? null,
    };
  });
}

/**
 * Idempotent seed: create an explicit ALLOWED row for every category that
 * has no policy rule yet. Returns the number of rows created.
 */
export async function seedDefaultPolicies(): Promise<number> {
  const existing = await prisma.categoryPolicyRule.findMany({ select: { category: true } });
  const have = new Set<string>(existing.map((r) => r.category));

  const missing = ALL_CATEGORIES.filter((c) => !have.has(c));
  if (missing.length === 0) return 0;

  const result = await prisma.categoryPolicyRule.createMany({
    data: missing.map((category) => ({ category, policy: 'ALLOWED' as const })),
  });

  return result.count;
}
