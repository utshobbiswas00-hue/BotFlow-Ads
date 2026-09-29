import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CHANNEL_CATEGORIES,
  MIN_CAMPAIGN_BUDGET_CENTS,
  createCampaignSchema,
  type CampaignSummary,
  type MarketplaceChannel,
} from '@botflow/shared';
import { api, errMsg } from '../lib/api';
import { isLimitError, limitMessage } from '../lib/errors';
import { qk } from '../lib/queryClient';
import type { AdCreative, MarketplaceFilters, UrlValidation } from '../lib/contracts';
import { categoryLabel, compactNumber, formatMoney, parseCents, pricingLabel } from '../lib/format';
import { useMarketplace } from '../hooks/useCampaigns';
import { campaignsQuota, usePremiumMe } from '../hooks/usePremium';
import { AdPreview } from '../components/domain/AdPreview';
import { LimitUpgradePrompt, QuotaMeter } from '../components/domain/PremiumUI';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Textarea } from '../components/ui/Textarea';
import { EmptyState, ErrorState, LoadMore } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { Icon } from '../components/ui/icons';
import { cn } from '../lib/cn';
import { showToast } from '../store/uiStore';

type FormatKey = AdCreative['format'];

interface WizardState {
  name: string;
  promotionTarget: string;
  format: FormatKey;
  text: string;
  imageUrl: string;
  buttonText: string;
  buttonUrl: string;
  destinationUrl: string;
  targetingMode: 'manual' | 'auto';
  selectedChannelIds: string[];
  mCategory: string;
  mMinSubs: string;
  aCategories: string[];
  aCountries: string;
  aLanguages: string;
  aSubMin: string;
  aSubMax: string;
  aViewsMin: string;
  aViewsMax: string;
  pricingModel: string;
  budget: string;
  frequency: number;
  startAt: string;
  endAt: string;
}

const initialState: WizardState = {
  name: '',
  promotionTarget: 'CHANNEL',
  format: 'TEXT',
  text: '',
  imageUrl: '',
  buttonText: '',
  buttonUrl: '',
  destinationUrl: '',
  targetingMode: 'manual',
  selectedChannelIds: [],
  mCategory: '',
  mMinSubs: '',
  aCategories: [],
  aCountries: '',
  aLanguages: '',
  aSubMin: '',
  aSubMax: '',
  aViewsMin: '',
  aViewsMax: '',
  pricingModel: 'FIXED',
  budget: '10',
  frequency: 1,
  startAt: '',
  endAt: '',
};

const STEPS = ['Content', 'Targeting', 'Budget', 'Review'] as const;

const fmtInt = (s: string): number => {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const isUrl = (s: string): boolean => {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

const splitCsv = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);

type UrlCheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'warning'; reasons: string[] }
  | { status: 'blocked'; reasons: string[] };

export function CreateCampaignPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [f, setF] = useState<WizardState>(initialState);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [created, setCreated] = useState<CampaignSummary | null>(null);
  const [agreePolicy, setAgreePolicy] = useState(false);

  /* Slots left on the active-campaign gate (GET /api/premium/me). Null when the
     backend does not report it, so a free account still sees a normal wizard. */
  const premium = usePremiumMe();
  const campaignQuota = campaignsQuota(premium.data);

  /* ---------------- destination URL validation (debounced ~600ms) ---------------- */
  const [urlCheck, setUrlCheck] = useState<UrlCheckState>({ status: 'idle' });
  const urlCheckSeq = useRef(0);

  useEffect(() => {
    const url = f.destinationUrl.trim();
    if (!url || !isUrl(url)) {
      setUrlCheck({ status: 'idle' });
      return;
    }
    setUrlCheck({ status: 'checking' });
    const seq = ++urlCheckSeq.current;
    const timer = setTimeout(() => {
      api
        .post<UrlValidation>('/api/url/validate', { url })
        .then((res) => {
          if (seq !== urlCheckSeq.current) return;
          const reasons = res.reasons ?? [];
          if (res.hardBlock) setUrlCheck({ status: 'blocked', reasons });
          else if (reasons.length > 0) setUrlCheck({ status: 'warning', reasons });
          else setUrlCheck({ status: 'idle' });
        })
        .catch(() => {
          // 404 / network failures must not block the form.
          if (seq !== urlCheckSeq.current) return;
          setUrlCheck({ status: 'idle' });
        });
    }, 600);
    return () => clearTimeout(timer);
  }, [f.destinationUrl]);

  const set = <K extends keyof WizardState>(key: K, value: WizardState[K]): void => {
    setF((prev) => ({ ...prev, [key]: value }));
    setFieldError(null);
  };

  /* ---------------- marketplace (manual targeting) ---------------- */
  const marketFilters: MarketplaceFilters = useMemo(
    () => ({
      ...(f.mCategory ? { category: f.mCategory } : {}),
      ...(f.mMinSubs ? { minSubs: fmtInt(f.mMinSubs) } : {}),
    }),
    [f.mCategory, f.mMinSubs],
  );
  const market = useMarketplace(marketFilters, 10);
  const marketChannels = useMemo(
    () => (market.data ? market.data.pages.flatMap((p) => p.items) : []),
    [market.data],
  );
  const selectedChannels = useMemo(
    () => marketChannels.filter((c) => f.selectedChannelIds.includes(c.id)),
    [marketChannels, f.selectedChannelIds],
  );
  const estimateCents = useMemo(
    () => selectedChannels.reduce((sum, c) => sum + c.adPriceCents, 0) * f.frequency,
    [selectedChannels, f.frequency],
  );

  const toggleChannel = (id: string): void => {
    setF((prev) => ({
      ...prev,
      selectedChannelIds: prev.selectedChannelIds.includes(id)
        ? prev.selectedChannelIds.filter((x) => x !== id)
        : [...prev.selectedChannelIds, id],
    }));
  };

  /* ---------------- step validation ---------------- */
  function validateStep(s: number): string | null {
    if (s === 0) {
      if (f.name.trim().length < 3 || f.name.trim().length > 120) return 'Campaign name must be 3–120 characters';
      if (f.text.trim().length < 1 || f.text.trim().length > 2000) return 'Ad text is required (max 2000 chars)';
      if ((f.format === 'IMAGE' || f.format === 'IMAGE_TEXT') && !f.imageUrl.trim()) return 'Add an image URL for this format';
      if (f.imageUrl && !isUrl(f.imageUrl)) return 'Image URL must be a valid http(s) link';
      if (f.format === 'BUTTON') {
        if (!f.buttonText.trim()) return 'Button label is required for BUTTON format';
        if (f.buttonText.length > 64) return 'Button label is limited to 64 characters';
      }
      if (f.buttonUrl && !isUrl(f.buttonUrl)) return 'Button URL must be a valid http(s) link';
      if (f.destinationUrl && !isUrl(f.destinationUrl)) return 'Destination URL must be a valid http(s) link';
      return null;
    }
    if (s === 1) {
      if (f.targetingMode === 'manual' && f.selectedChannelIds.length === 0)
        return 'Select at least one channel (or switch to auto-targeting)';
      return null;
    }
    if (s === 2) {
      const cents = parseCents(f.budget);
      if (cents === null || cents < MIN_CAMPAIGN_BUDGET_CENTS)
        return `Budget must be at least ${formatMoney(MIN_CAMPAIGN_BUDGET_CENTS)}`;
      if (f.startAt && f.endAt && new Date(f.endAt) <= new Date(f.startAt))
        return 'End time must be after start time';
      return null;
    }
    return null;
  }

  const next = (): void => {
    const err = validateStep(step);
    if (err) {
      setFieldError(err);
      return;
    }
    setStep((s) => Math.min(s + 1, 3));
    window.scrollTo({ top: 0 });
  };
  const prev = (): void => {
    setStep((s) => Math.max(s - 1, 0));
    window.scrollTo({ top: 0 });
  };

  /* ---------------- payload + submit ---------------- */
  const buildPayload = (): Record<string, unknown> => {
    const creative: AdCreative = {
      format: f.format,
      text: f.text.trim(),
      imageUrl: f.imageUrl.trim() || null,
      buttonText: f.buttonText.trim() || null,
      buttonUrl: f.buttonUrl.trim() || null,
      destinationUrl: f.destinationUrl.trim() || null,
      weight: 1,
    };
    return {
      name: f.name.trim(),
      promotionTarget: f.promotionTarget,
      pricingModel: f.pricingModel,
      budgetCents: parseCents(f.budget) ?? 0,
      frequencyPerChannel: f.frequency,
      isAutoTargeting: f.targetingMode === 'auto',
      targeting: {
        categories: f.aCategories,
        countries: splitCsv(f.aCountries).map((s) => s.toUpperCase().slice(0, 2)),
        languages: splitCsv(f.aLanguages).map((s) => s.toLowerCase().slice(0, 8)),
        subscriberMin: fmtInt(f.aSubMin),
        subscriberMax: fmtInt(f.aSubMax),
        avgViewsMin: fmtInt(f.aViewsMin),
        avgViewsMax: fmtInt(f.aViewsMax),
      },
      channelIds: f.targetingMode === 'manual' ? f.selectedChannelIds : [],
      startAt: f.startAt ? new Date(f.startAt).toISOString() : null,
      endAt: f.endAt ? new Date(f.endAt).toISOString() : null,
      creatives: [creative],
    };
  };

  const submit = useMutation({
    mutationFn: async (payload: Record<string, unknown>): Promise<CampaignSummary> => {
      const parsed = createCampaignSchema.safeParse(payload);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const msg = first?.message ?? 'Invalid campaign payload';
        const where = first && first.path.length > 0 ? first.path.join('.') : '';
        throw new Error(where ? `${where}: ${msg}` : msg);
      }
      // Zod strips unknown keys, so re-add the consent flag after parsing.
      return api.post<CampaignSummary>('/api/campaigns', { ...parsed.data, acceptedPolicy: true });
    },
    onSuccess: (data) => {
      showToast('success', 'Campaign submitted for review');
      void qc.invalidateQueries({ queryKey: qk.campaigns });
      setCreated(data);
      setTimeout(() => navigate(`/campaigns/${data.id}`, { replace: true }), 1200);
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const doSubmit = (): void => {
    const err = validateStep(3);
    if (err) {
      setFieldError(err);
      return;
    }
    if (!agreePolicy) return;
    // Fire-and-forget consent persistence — a failure here must never block
    // the campaign submission itself.
    void api.post('/api/legal/advertiser-policy/accept').catch(() => undefined);
    void api.post('/api/legal/terms/accept').catch(() => undefined);
    submit.mutate(buildPayload());
  };

  /* ---------------- success screen ---------------- */
  if (created) {
    return (
      <>
        <PageHeader title="Campaign created" back />
        <div className="flex flex-col items-center text-center py-14">
          <div className="w-16 h-16 rounded-full bg-ok/10 text-ok flex items-center justify-center mb-4">
            <Icon name="check" size={30} />
          </div>
          <h2 className="text-lg font-bold">“{created.name}” is in review</h2>
          <p className="text-sm text-mute mt-1 max-w-64">
            Our team will approve it shortly. Track progress from the campaign page.
          </p>
          <div className="mt-6 w-full max-w-60">
            <Button full onClick={() => navigate(`/campaigns/${created.id}`, { replace: true })}>
              View campaign
            </Button>
          </div>
        </div>
      </>
    );
  }

  const budgetCents = parseCents(f.budget) ?? 0;

  return (
    <>
      <PageHeader title="New campaign" back />

      {/* Stepper */}
      <div className="flex items-center gap-1.5 py-3">
        {STEPS.map((label, i) => (
          <button key={label} onClick={() => i < step && setStep(i)} className={cn('flex-1', i > step && 'cursor-default')}>
            <div className={cn('h-1.5 rounded-full transition-colors', i <= step ? 'bg-accent' : 'bg-line')} />
            <p className={cn('text-[10px] mt-1 font-medium text-center', i === step ? 'text-accent' : 'text-mute')}>
              {i + 1}. {label}
            </p>
          </button>
        ))}
      </div>

      {campaignQuota && (
        <Card className="mb-3">
          <QuotaMeter label="Active campaigns you can run" quota={campaignQuota} />
        </Card>
      )}

      {fieldError && (
        <div className="mb-3 flex items-start gap-2 rounded-xl bg-danger/10 text-danger px-3.5 py-3 text-sm">
          <Icon name="alert" size={17} className="shrink-0 mt-0.5" />
          {fieldError}
        </div>
      )}

      {/* STEP 1 — content */}
      {step === 0 && (
        <div className="space-y-4">
          <Card className="space-y-4">
            <Input
              label="Campaign name"
              placeholder="e.g. Spring sale launch"
              value={f.name}
              onChange={(e) => set('name', e.target.value)}
              maxLength={120}
            />
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Promoting"
                value={f.promotionTarget}
                onChange={(e) => set('promotionTarget', e.target.value)}
                options={[
                  { value: 'CHANNEL', label: 'Telegram channel' },
                  { value: 'GROUP', label: 'Telegram group' },
                  { value: 'BOT', label: 'Telegram bot' },
                  { value: 'APP', label: 'App' },
                  { value: 'PRODUCT', label: 'Product' },
                  { value: 'SERVICE', label: 'Service' },
                  { value: 'WEBSITE', label: 'Website' },
                  { value: 'BRAND', label: 'Brand' },
                ]}
              />
              <Select
                label="Format"
                value={f.format}
                onChange={(e) => set('format', e.target.value as FormatKey)}
                options={[
                  { value: 'TEXT', label: 'Text only' },
                  { value: 'IMAGE', label: 'Image' },
                  { value: 'IMAGE_TEXT', label: 'Image + text' },
                  { value: 'BUTTON', label: 'Text + button' },
                ]}
              />
            </div>
            <Textarea
              label="Ad text"
              placeholder="Write your sponsored post…"
              value={f.text}
              onChange={(e) => set('text', e.target.value)}
              maxLength={2000}
              showCount
              rows={5}
            />
            {(f.format === 'IMAGE' || f.format === 'IMAGE_TEXT') && (
              <Input
                label="Image URL"
                placeholder="https://…/photo.jpg"
                icon="external"
                value={f.imageUrl}
                onChange={(e) => set('imageUrl', e.target.value)}
                hint="A public https image link"
              />
            )}
            {f.format === 'BUTTON' && (
              <div className="space-y-3">
                <Input
                  label="Button label"
                  placeholder="e.g. Sign up now"
                  value={f.buttonText}
                  onChange={(e) => set('buttonText', e.target.value)}
                  maxLength={64}
                />
                <Input
                  label="Button link"
                  placeholder="https://t.me/your_bot"
                  icon="external"
                  value={f.buttonUrl}
                  onChange={(e) => set('buttonUrl', e.target.value)}
                />
              </div>
            )}
            <Input
              label="Destination URL (optional)"
              placeholder="https://…"
              icon="external"
              value={f.destinationUrl}
              onChange={(e) => set('destinationUrl', e.target.value)}
            />
            {urlCheck.status === 'checking' && (
              <p className="text-xs text-mute -mt-2">Checking link…</p>
            )}
            {urlCheck.status === 'warning' && (
              <div className="flex items-start gap-2 rounded-xl bg-warn/10 text-warn px-3.5 py-3 text-xs leading-relaxed">
                <Icon name="alert" size={15} className="shrink-0 mt-0.5" />
                <span>
                  This link may need extra review before delivery
                  {urlCheck.reasons.length > 0 ? `: ${urlCheck.reasons.join('; ')}` : '.'}
                </span>
              </div>
            )}
            {urlCheck.status === 'blocked' && (
              <div className="flex items-start gap-2 rounded-xl bg-danger/10 text-danger px-3.5 py-3 text-xs leading-relaxed">
                <Icon name="alert" size={15} className="shrink-0 mt-0.5" />
                <span>
                  This link can't be used in a campaign
                  {urlCheck.reasons.length > 0 ? `: ${urlCheck.reasons.join('; ')}` : '.'}
                </span>
              </div>
            )}
          </Card>

          <div>
            <p className="text-sm font-semibold text-mute uppercase tracking-wide mb-2">Live preview</p>
            <AdPreview
              text={f.text || 'Your ad text will appear here…'}
              imageUrl={f.imageUrl || null}
              buttonText={f.buttonText || null}
              buttonUrl={f.buttonUrl || null}
            />
          </div>
        </div>
      )}

      {/* STEP 2 — targeting */}
      {step === 1 && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 bg-surface border border-line rounded-2xl p-1.5">
            {(['manual', 'auto'] as const).map((m) => (
              <button
                key={m}
                onClick={() => set('targetingMode', m)}
                className={cn(
                  'h-10 rounded-xl text-sm font-semibold transition-colors',
                  f.targetingMode === m ? 'bg-accent text-accentink' : 'text-mute',
                )}
              >
                {m === 'manual' ? 'Pick channels' : 'Auto-targeting'}
              </button>
            ))}
          </div>

          {f.targetingMode === 'manual' ? (
            <>
              <Card className="space-y-3">
                <Select
                  label="Category"
                  placeholder="All categories"
                  value={f.mCategory}
                  onChange={(e) => set('mCategory', e.target.value)}
                  options={CHANNEL_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))}
                />
                <Input
                  label="Min subscribers"
                  type="number"
                  inputMode="numeric"
                  placeholder="e.g. 1000"
                  value={f.mMinSubs}
                  onChange={(e) => set('mMinSubs', e.target.value)}
                />
              </Card>

              {market.isLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 4 }, (_, i) => (
                    <Skeleton key={i} className="h-[74px]" />
                  ))}
                </div>
              ) : market.isError ? (
                <ErrorState message={errMsg(market.error)} onRetry={() => void market.refetch()} />
              ) : marketChannels.length === 0 ? (
                <EmptyState icon="search" title="No channels match" message="Try loosening the filters above." />
              ) : (
                <div className="space-y-3">
                  {marketChannels.map((c) => (
                    <MarketRow
                      key={c.id}
                      channel={c}
                      selected={f.selectedChannelIds.includes(c.id)}
                      onToggle={() => toggleChannel(c.id)}
                    />
                  ))}
                  <LoadMore
                    hasMore={market.hasNextPage ?? false}
                    loading={market.isFetchingNextPage}
                    onClick={() => void market.fetchNextPage()}
                  />
                </div>
              )}
            </>
          ) : (
            <Card className="space-y-3">
              <div>
                <p className="text-sm font-medium mb-2">Categories</p>
                <div className="flex flex-wrap gap-1.5">
                  {CHANNEL_CATEGORIES.map((c) => {
                    const on = f.aCategories.includes(c);
                    return (
                      <button
                        key={c}
                        onClick={() => set('aCategories', on ? f.aCategories.filter((x) => x !== c) : [...f.aCategories, c])}
                        className={cn(
                          'h-8 px-3 rounded-full text-xs font-medium border',
                          on ? 'bg-accent text-accentink border-accent' : 'bg-surface border-line text-mute',
                        )}
                      >
                        {categoryLabel(c)}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Countries" placeholder="BD, IN, US" value={f.aCountries} onChange={(e) => set('aCountries', e.target.value)} hint="2-letter codes, comma separated" />
                <Input label="Languages" placeholder="en, bn" value={f.aLanguages} onChange={(e) => set('aLanguages', e.target.value)} hint="2-letter codes, comma separated" />
                <Input label="Min subscribers" type="number" inputMode="numeric" placeholder="1000" value={f.aSubMin} onChange={(e) => set('aSubMin', e.target.value)} />
                <Input label="Max subscribers" type="number" inputMode="numeric" placeholder="500000" value={f.aSubMax} onChange={(e) => set('aSubMax', e.target.value)} />
                <Input label="Min avg views" type="number" inputMode="numeric" placeholder="500" value={f.aViewsMin} onChange={(e) => set('aViewsMin', e.target.value)} />
                <Input label="Max avg views" type="number" inputMode="numeric" placeholder="100000" value={f.aViewsMax} onChange={(e) => set('aViewsMax', e.target.value)} />
              </div>
              <p className="text-xs text-mute bg-app rounded-xl px-3 py-2.5">
                💡 We automatically select the best-matching channels at delivery time.
              </p>
            </Card>
          )}

          {f.targetingMode === 'manual' && f.selectedChannelIds.length > 0 && (
            <Card className="bg-accent/5 border-accent/30">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-mute">
                    {f.selectedChannelIds.length} channel{f.selectedChannelIds.length > 1 ? 's' : ''} · ×{f.frequency} post
                    {f.frequency > 1 ? 's' : ''}
                  </p>
                  <p className="text-lg font-bold">Est. {formatMoney(estimateCents)}</p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => navigate('/marketplace')}>
                  Browse more
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* STEP 3 — budget & schedule */}
      {step === 2 && (
        <div className="space-y-4">
          <Card className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Budget"
                type="number"
                inputMode="decimal"
                min={0}
                step="1"
                prefix="$"
                value={f.budget}
                onChange={(e) => set('budget', e.target.value)}
                hint={`Minimum ${formatMoney(MIN_CAMPAIGN_BUDGET_CENTS)}`}
              />
              <Select
                label="Posts per channel"
                value={String(f.frequency)}
                onChange={(e) => set('frequency', parseInt(e.target.value, 10))}
                options={[
                  { value: '1', label: '1 post' },
                  { value: '2', label: '2 posts' },
                  { value: '3', label: '3 posts' },
                ]}
              />
            </div>
            <Select
              label="Pricing model"
              value={f.pricingModel}
              onChange={(e) => set('pricingModel', e.target.value)}
              options={[
                { value: 'FIXED', label: 'Fixed — pay per post' },
                { value: 'CPM', label: 'CPM — pay per 1,000 views' },
                { value: 'CPC', label: 'CPC — pay per click' },
                { value: 'HYBRID', label: 'Hybrid' },
              ]}
            />
            <div className="grid grid-cols-1 gap-3">
              <Input label="Start (optional)" type="datetime-local" value={f.startAt} onChange={(e) => set('startAt', e.target.value)} />
              <Input label="End (optional)" type="datetime-local" value={f.endAt} onChange={(e) => set('endAt', e.target.value)} />
            </div>
          </Card>

          <Card>
            <div className="flex items-center justify-between text-sm">
              <span className="text-mute">Estimated total</span>
              <span className="font-bold text-base">
                {f.targetingMode === 'manual' ? formatMoney(estimateCents) : 'Depends on matched channels'}
              </span>
            </div>
            <p className="text-xs text-mute mt-1.5">
              Your balance is reserved at approval. Unused budget is refunded automatically.
            </p>
          </Card>
        </div>
      )}

      {/* STEP 4 — review */}
      {step === 3 && (
        <div className="space-y-4">
          <Card className="space-y-3">
            <ReviewRow k="Name" v={f.name} />
            <ReviewRow k="Promoting" v={f.promotionTarget.replace('_', ' ')} />
            <ReviewRow k="Format" v={f.format.replace('_', ' ')} />
            <ReviewRow
              k="Targeting"
              v={
                f.targetingMode === 'auto'
                  ? `Auto · ${f.aCategories.length} categories, ${splitCsv(f.aCountries).length} countries`
                  : `${f.selectedChannelIds.length} selected channels`
              }
            />
            <ReviewRow k="Pricing" v={f.pricingModel} />
            <ReviewRow k="Posts per channel" v={String(f.frequency)} />
            <ReviewRow k="Budget" v={formatMoney(budgetCents)} />
            <ReviewRow
              k="Schedule"
              v={f.startAt || f.endAt ? `${f.startAt || '…'} → ${f.endAt || '…'}` : 'Starts after approval'}
            />
            <ReviewRow k="Est. delivery cost" v={f.targetingMode === 'manual' ? formatMoney(estimateCents) : 'Calculated at delivery'} />
          </Card>

          <div>
            <p className="text-sm font-semibold text-mute uppercase tracking-wide mb-2">Ad preview</p>
            <AdPreview text={f.text} imageUrl={f.imageUrl || null} buttonText={f.buttonText || null} buttonUrl={f.buttonUrl || null} />
          </div>

          {/* Consent — required before submit */}
          <Card>
            <label className="flex items-start gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                className="sr-only"
                checked={agreePolicy}
                onChange={(e) => setAgreePolicy(e.target.checked)}
              />
              <span
                className={cn(
                  'mt-0.5 w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition-colors',
                  agreePolicy ? 'bg-accent border-accent text-accentink' : 'bg-surface border-line',
                )}
              >
                {agreePolicy && <Icon name="check" size={13} />}
              </span>
              <span className="text-sm leading-relaxed">
                I have read and agree to the{' '}
                <Link to="/legal/advertiser-policy" className="text-link font-medium">
                  Advertiser Policy
                </Link>{' '}
                and the{' '}
                <Link to="/legal/terms" className="text-link font-medium">
                  Terms of Service
                </Link>
              </span>
            </label>
          </Card>

          {submit.isError &&
            (isLimitError(submit.error) ? (
              /* The gate refused the campaign: show its own sentence and the
                 upgrade path instead of a red blob the user cannot act on. */
              <LimitUpgradePrompt
                title="You have reached your active-campaign limit"
                message={limitMessage(submit.error)}
              />
            ) : (
              <div className="flex items-start gap-2 rounded-xl bg-danger/10 text-danger px-3.5 py-3 text-sm">
                <Icon name="alert" size={17} className="shrink-0 mt-0.5" />
                {errMsg(submit.error)}
              </div>
            ))}
        </div>
      )}

      {/* Footer nav */}
      <div className="flex gap-2 pt-2 pb-4">
        {step > 0 && (
          <Button variant="secondary" size="lg" onClick={prev} className="flex-1">
            Back
          </Button>
        )}
        {step < 3 ? (
          <Button size="lg" onClick={next} className="flex-[2]">
            Continue
          </Button>
        ) : (
          <Button size="lg" onClick={doSubmit} loading={submit.isPending} disabled={!agreePolicy} className="flex-[2]">
            Submit campaign
          </Button>
        )}
      </div>
    </>
  );
}

/** Selectable marketplace row inside the wizard. */
function MarketRow({ channel, selected, onToggle }: { channel: MarketplaceChannel; selected: boolean; onToggle: () => void }) {
  const name = channel.title || channel.username || 'Channel';
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'w-full bg-surface border rounded-2xl p-3 flex items-center gap-3 text-left active:opacity-80',
        selected ? 'border-accent ring-1 ring-accent' : 'border-line',
      )}
    >
      <div className="w-10 h-10 rounded-full bg-accent/10 text-accent flex items-center justify-center font-bold text-sm shrink-0 overflow-hidden">
        {channel.photoUrl ? (
          <img src={channel.photoUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
        ) : (
          name.charAt(0).toUpperCase()
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm truncate">{name}</p>
        <p className="text-xs text-mute truncate mt-0.5">
          {categoryLabel(channel.category)} · {compactNumber(channel.subscriberCount)} subs
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-xs font-bold whitespace-nowrap">{pricingLabel(channel.pricingModel, channel.adPriceCents)}</p>
        <span
          className={cn(
            'mt-1 inline-flex w-6 h-6 rounded-full border items-center justify-center',
            selected ? 'bg-accent border-accent text-accentink' : 'border-line text-transparent',
          )}
        >
          <Icon name="check" size={14} />
        </span>
      </div>
    </button>
  );
}

function ReviewRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="text-mute shrink-0">{k}</span>
      <span className="font-medium text-right break-words">{v}</span>
    </div>
  );
}
