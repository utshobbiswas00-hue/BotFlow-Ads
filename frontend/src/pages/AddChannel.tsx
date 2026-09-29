import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CHANNEL_CATEGORIES, type ChannelSummary } from '@botflow/shared';
import { api, errMsg } from '../lib/api';
import { qk } from '../lib/queryClient';
import { categoryLabel } from '../lib/format';
import { PageHeader } from '../components/layout/PageHeader';
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

export function AddChannelPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const [category, setCategory] = useState('NEWS');
  const [language, setLanguage] = useState('en');
  const [country, setCountry] = useState('BD');
  const [agreePolicy, setAgreePolicy] = useState(false);

  const create = useMutation({
    mutationFn: (body: {
      channelUsername: string;
      category: string;
      language: string;
      country: string;
      acceptedPolicy: boolean;
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
    if (!agreePolicy) return;
    // Fire-and-forget consent persistence — a failure here must never block
    // the channel submission itself.
    void api.post('/api/legal/publisher-agreement/accept').catch(() => undefined);
    void api.post('/api/legal/terms/accept').catch(() => undefined);
    create.mutate({ channelUsername: cleaned, category, language, country, acceptedPolicy: true });
  };

  return (
    <>
      <PageHeader title="Add channel" back />

      <div className="space-y-4 mt-1">
        <Card className="space-y-4">
          <div className="flex items-start gap-3 bg-app rounded-xl px-3.5 py-3">
            <Icon name="info" size={18} className="text-link shrink-0 mt-0.5" />
            <p className="text-xs text-mute leading-relaxed">
              Your channel must be a <b>public</b> Telegram channel. You can submit it now and add the BotFlow
              bot as an admin afterwards — we'll walk you through that on the next screen.
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

        <Card className="space-y-2">
          <h3 className="text-sm font-semibold">How it works</h3>
          <ol className="text-sm text-mute space-y-1.5 list-decimal list-inside">
            <li>Submit the channel — no admin rights needed yet.</li>
            <li>Add the BotFlow bot as an admin (one tap on the next screen).</li>
            <li>Once approved, sponsorship requests appear in your inbox.</li>
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

        <Button
          full
          size="lg"
          loading={create.isPending}
          disabled={!agreePolicy}
          onClick={submit}
          icon={<Icon name="check" size={18} />}
        >
          Submit for review
        </Button>
      </div>
    </>
  );
}
