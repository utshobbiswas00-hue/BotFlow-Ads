import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CHANNEL_CATEGORIES,
  MAX_WEEKLY_POSTS,
  WEEKDAYS,
  weeklySlotCount,
  type ChannelSummary,
  type PostingSchedule,
} from '@botflow/shared';
import { api, errMsg } from '../lib/api';
import { qk } from '../lib/queryClient';
import { categoryLabel } from '../lib/format';
import { PageHeader } from '../components/layout/PageHeader';
import { PostingScheduleEditor } from '../components/channels/PostingScheduleEditor';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Icon } from '../components/ui/icons';
import { cn } from '../lib/cn';
import { showToast } from '../store/uiStore';

const COUNTRIES = [
  { code: 'BD', name: 'Bangladesh' },
  { code: 'IN', name: 'India' },
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'DE', name: 'Germany' },
  { code: 'AE', name: 'UAE' },
  { code: 'SA', name: 'Saudi Arabia' },
  { code: 'PK', name: 'Pakistan' },
  { code: 'MY', name: 'Malaysia' },
  { code: 'ID', name: 'Indonesia' },
  { code: 'TR', name: 'Turkey' },
  { code: 'RU', name: 'Russia' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
];

const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'bn', name: 'Bengali' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ur', name: 'Urdu' },
  { code: 'id', name: 'Indonesian' },
  { code: 'ms', name: 'Malay' },
  { code: 'ar', name: 'Arabic' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ru', name: 'Russian' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
];

/**
 * Sensible starting schedule: 3 posts a day (09:00, 15:00, 21:00) on all 7
 * days — exactly MAX_WEEKLY_POSTS (21) a week.
 */
function defaultWeeklySchedule(): PostingSchedule {
  return Object.fromEntries(WEEKDAYS.map((day) => [String(day), ['09:00', '15:00', '21:00']]));
}

export function AddChannelPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const [category, setCategory] = useState('NEWS');
  const [language, setLanguage] = useState('en');
  const [country, setCountry] = useState('BD');
  const [agreePolicy, setAgreePolicy] = useState(false);
  const [schedule, setSchedule] = useState<PostingSchedule>(defaultWeeklySchedule);

  const create = useMutation({
    mutationFn: (body: {
      channelUsername: string;
      category: string;
      language: string;
      country: string;
      acceptedPolicy: boolean;
      postingSchedule: PostingSchedule;
    }): Promise<ChannelSummary> => api.post<ChannelSummary>('/api/channels', body),
    onSuccess: (data) => {
      showToast('success', 'Channel added');
      void qc.invalidateQueries({ queryKey: qk.channels });
      navigate(`/channels/${data.id}`, { replace: true });
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const submit = (): void => {
    const cleaned = username.trim().replace(/^@/, '');
    if (cleaned.length < 3) {
      showToast('error', 'Enter a valid Telegram channel username (e.g. mychannel)');
      return;
    }
    const weeklyTotal = weeklySlotCount(schedule);
    if (weeklyTotal > MAX_WEEKLY_POSTS) {
      showToast(
        'error',
        `A channel can accept at most ${MAX_WEEKLY_POSTS} posts a week (you picked ${weeklyTotal}). Remove ${
          weeklyTotal - MAX_WEEKLY_POSTS
        } to continue.`,
      );
      return;
    }
    if (!agreePolicy) return;
    // Fire-and-forget consent persistence — a failure here must never block
    // the channel submission itself.
    void api.post('/api/legal/publisher-agreement/accept').catch(() => undefined);
    void api.post('/api/legal/terms/accept').catch(() => undefined);
    create.mutate({
      channelUsername: cleaned,
      category,
      language,
      country,
      acceptedPolicy: true,
      postingSchedule: schedule,
    });
  };

  return (
    <>
      <PageHeader title="Add channel" back />

      <div className="space-y-4 mt-1">
        <Card className="space-y-4">
          <div className="flex items-start gap-3 bg-app rounded-xl px-3.5 py-3">
            <Icon name="info" size={18} className="text-link shrink-0 mt-0.5" />
            <p className="text-xs text-mute leading-relaxed">
              Your channel must be a <b>public</b> Telegram channel. You can add it now and grant
              @BotflowadsBot admin access afterwards — the next screen walks you through that.
            </p>
          </div>
          <Input
            label="Channel username"
            placeholder="mychannel"
            icon="external"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            hint="Public @username without the @"
          />
          <Select
            label="Category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            options={CHANNEL_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))}
          />
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              options={LANGUAGES.map((l) => ({ value: l.code, label: l.name }))}
            />
            <Select
              label="Country"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              options={COUNTRIES.map((c) => ({ value: c.code, label: c.name }))}
            />
          </div>
        </Card>

        <PostingScheduleEditor value={schedule} onChange={setSchedule} />

        <Card className="space-y-2">
          <h3 className="text-sm font-semibold">How it works</h3>
          <ol className="text-sm text-mute space-y-1.5 list-decimal list-inside">
            <li>Add your channel — no admin rights needed yet.</li>
            <li>Pick the days and times you will accept a sponsored post — up to 21 a week.</li>
            <li>Grant @BotflowadsBot admin access with "Post Messages" on, one tap on the next screen.</li>
            <li>Your channel goes live automatically the moment the bot has those rights — no approval queue.</li>
          </ol>
        </Card>

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
              <Link to="/legal/publisher-agreement" className="text-link font-medium">
                Publisher Agreement
              </Link>{' '}
              and the{' '}
              <Link to="/legal/terms" className="text-link font-medium">
                Terms of Service
              </Link>
            </span>
          </label>
        </Card>

        <p className="text-xs text-mute leading-relaxed px-1">
          You can submit without the bot having access yet — grant it on the next screen. Your channel
          goes live automatically the moment the bot has those rights.
        </p>

        <Button
          full
          size="lg"
          loading={create.isPending}
          disabled={!agreePolicy}
          onClick={submit}
          icon={<Icon name="check" size={18} />}
        >
          Add channel
        </Button>
      </div>
    </>
  );
}
