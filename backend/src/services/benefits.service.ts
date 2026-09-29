import { businessRules } from './settings.service';
import { publisherCpmRateCents, projectEarnings } from './cpmPayout.service';
import { computeReachPlan, formatReach, reachPromise } from './reachEstimator.service';
import { getSlotMix, explainSlotMix } from './slotPlanner.service';

/**
 * WHAT THE PLATFORM GIVES YOU.
 *
 * One service that answers the two questions a new user always asks, in the
 * exact numbers the platform actually runs on — never a marketing figure that
 * does not match the billing code:
 *
 *   Publisher : "How much do I earn?"      -> $1.80 per 1,000 measured views
 *   Advertiser: "What does my budget buy?" -> an estimated reach, not one post
 *
 * Every number here is read from the same settings the money paths use, so the
 * app can never promise something the backend will not pay.
 */

export interface EarningsRow {
  views: number;
  viewsLabel: string;
  cents: number;
  amountLabel: string;
}

export interface PublisherBenefits {
  headline: string;
  rateCents: number;
  rateLabel: string;
  howItWorks: string[];
  earningsTable: EarningsRow[];
  slotMix: { paidPercent: number; housePercent: number; summary: string; publisherNote: string };
  measurementNote: string;
  payoutTiming: string;
  perViewLabel: string;
}

export interface AdvertiserBenefits {
  headline: string;
  minimumBudgetCents: number;
  minimumBudgetLabel: string;
  examples: Array<{ budgetCents: number; budgetLabel: string; promise: string; reachMin: number; reachMax: number }>;
  howItWorks: string[];
  slotMixNote: string;
  billingNote: string;
}

const VIEW_STEPS = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 500_000];

/**
 * The "$1.80 per 1,000 views" promise, laid out as a table a user can scan.
 * 1,000 views -> $1.80, 25,000 -> $45.00, 100,000 -> $180.00.
 */
export async function publisherEarningsTable(
  rateCents?: number,
  steps: number[] = VIEW_STEPS,
): Promise<EarningsRow[]> {
  const rate = rateCents ?? (await businessRules.publisherCpmRateCents());
  return steps.map((views) => {
    const { cents, label } = projectEarnings(views, rate);
    return { views, viewsLabel: formatReach(views), cents, amountLabel: label };
  });
}

export async function publisherBenefits(): Promise<PublisherBenefits> {
  const [rateCents, mix, holdHours, table] = await Promise.all([
    publisherCpmRateCents({ publisherCpmRateCents: null }),
    getSlotMix(),
    businessRules.earningHoldHours(),
    publisherEarningsTable(),
  ]);

  const mixCopy = explainSlotMix(mix);
  const perView = rateCents / 1000;

  return {
    headline: `Earn $${(rateCents / 100).toFixed(2)} for every 1,000 views on sponsored posts in your channel.`,
    rateCents,
    rateLabel: `$${(rateCents / 100).toFixed(2)} per 1,000 views`,
    perViewLabel: `$${perView.toFixed(5)} per view`,
    howItWorks: [
      'Add your Telegram channel and make @BotflowadsBot an administrator with the "Post Messages" permission.',
      'Approve or let us place sponsored posts in your channel.',
      "A post's views are counted from Telegram where we can measure them, and you are paid for each 1,000.",
      `Earnings sit as pending for ${holdHours} hour(s), then become available to withdraw.`,
      'Sponsored posts are always clearly labelled, and you can reject any post you do not want.',
    ],
    earningsTable: table,
    slotMix: {
      paidPercent: mixCopy.paidPercent,
      housePercent: mixCopy.housePercent,
      summary: mixCopy.summary,
      publisherNote: mixCopy.publisherNote,
    },
    measurementNote:
      'You are paid on measured views only. Telegram does not return a view count through the bot API, so views are read from a measurement source; a post we cannot measure is never paid on an invented number.',
    payoutTiming: `Pending for ${holdHours} hour(s), then withdrawable.`,
  };
}

export async function advertiserBenefits(): Promise<AdvertiserBenefits> {
  const minBudget = await businessRules.minAdvertiserBudgetCents();
  const sampleBudgets = [minBudget, 2000, 5000, 10000, 25000];

  const examples = await Promise.all(
    sampleBudgets.map(async (budgetCents) => {
      const plan = await computeReachPlan(budgetCents);
      return {
        budgetCents,
        budgetLabel: `$${(budgetCents / 100).toFixed(2)}`,
        promise: reachPromise(plan),
        reachMin: plan.reachMin,
        reachMax: plan.reachMax,
      };
    }),
  );

  const mix = await getSlotMix();
  const mixCopy = explainSlotMix(mix);

  return {
    headline: 'Pay for an audience, not for a single post.',
    minimumBudgetCents: minBudget,
    minimumBudgetLabel: `$${(minBudget / 100).toFixed(2)}`,
    examples,
    howItWorks: [
      'Set a budget. We show you the estimated reach it buys before you pay anything.',
      'Your creative is reviewed, then placed across the channels that fit your targeting.',
      `Around ${mixCopy.paidPercent}% of sponsored slots carry paying advertisers' creatives.`,
      'Budget is reserved up front and only spent as posts are actually published.',
      'A post that fails to publish is never charged, and its reserved amount returns to your balance.',
    ],
    slotMixNote: mixCopy.summary,
    billingNote:
      'Reach is an estimate of audience, not a promise of views or clicks. You are charged for published posts only; a failed or expired placement costs you nothing.',
  };
}

export interface ViewMilestone {
  views: number;
  viewsLabel: string;
  amountLabel: string;
}

/** Compact list used by the bot's /earn command and the dashboard hero. */
export async function quickEarningsMilestones(): Promise<ViewMilestone[]> {
  const rows = await publisherEarningsTable();
  return rows.map((r) => ({ views: r.views, viewsLabel: r.viewsLabel, amountLabel: r.amountLabel }));
}

/** Everything the Mini App's "Benefits" page needs in one request. */
export async function allBenefits() {
  const [publisher, advertiser] = await Promise.all([publisherBenefits(), advertiserBenefits()]);
  return { publisher, advertiser };
}
