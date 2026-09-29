import { useId, useState } from 'react';
import {
  MAX_WEEKLY_POSTS,
  WEEKDAYS,
  WEEKDAY_LABELS,
  weeklySlotCount,
  type PostingSchedule,
} from '@botflow/shared';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Input } from '../ui/Input';
import { Icon } from '../ui/icons';
import { cn } from '../../lib/cn';

/** "HH:mm", 24-hour, zero-padded — mirrors the shared `postingTimeSchema`. */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Keep only valid HH:mm entries, drop duplicates, then order ascending.
 * Lexicographic ordering equals chronological ordering for zero-padded 24h
 * times.
 */
export function normalizePostingTimes(times: string[] | undefined): string[] {
  if (!times) return [];
  return Array.from(new Set(times.filter((t) => TIME_PATTERN.test(t)))).sort();
}

export interface PostingScheduleEditorProps {
  value: PostingSchedule;
  onChange: (next: PostingSchedule) => void;
}

/**
 * Weekly posting-schedule editor. One row per weekday (Sunday first); each row
 * lists the day's chosen times as removable chips and offers a time input to
 * add another. Times within a day are always sorted and deduplicated.
 */
export function PostingScheduleEditor({ value, onChange }: PostingScheduleEditorProps) {
  const inputIdBase = useId();
  // Per-day add-input draft ("HH:mm") and a per-day invalid flag.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});

  const total = weeklySlotCount(value);
  const overCap = total > MAX_WEEKLY_POSTS;

  const writeDay = (day: number, times: string[]): void => {
    const key = String(day);
    const cleaned = normalizePostingTimes(times);
    const next: PostingSchedule = { ...value };
    if (cleaned.length === 0) {
      delete next[key];
    } else {
      next[key] = cleaned;
    }
    onChange(next);
  };

  const addTime = (day: number): void => {
    const key = String(day);
    const time = (drafts[key] ?? '').trim();
    const current = normalizePostingTimes(value[key]);
    if (!TIME_PATTERN.test(time) || current.includes(time)) {
      setInvalid((prev) => ({ ...prev, [key]: true }));
      return;
    }
    setInvalid((prev) => ({ ...prev, [key]: false }));
    setDrafts((prev) => ({ ...prev, [key]: '' }));
    writeDay(day, [...current, time]);
  };

  const removeTime = (day: number, time: string): void => {
    writeDay(day, normalizePostingTimes(value[String(day)]).filter((t) => t !== time));
  };

  return (
    <Card className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Weekly posting schedule</h3>
          <p className="text-xs text-mute mt-0.5">
            Channel-local times. Each day stays sorted and never repeats.
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold tabular-nums',
            overCap ? 'border-danger/40 bg-danger/10 text-danger' : 'border-line bg-app text-mute',
          )}
        >
          {total} / {MAX_WEEKLY_POSTS}
        </span>
      </div>

      <div className="space-y-2.5">
        {WEEKDAYS.map((day) => {
          const key = String(day);
          const label = WEEKDAY_LABELS[day];
          const times = normalizePostingTimes(value[key]);
          const isInvalid = invalid[key] === true;
          return (
            <div key={key} className="rounded-xl border border-line bg-app p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-sm font-medium">{label}</span>
                <span className="text-xs text-mute tabular-nums">
                  {times.length === 0 ? 'No posts' : times.length === 1 ? '1 post' : `${times.length} posts`}
                </span>
              </div>

              {times.length > 0 && (
                <ul className="flex flex-wrap gap-1.5 mb-2" aria-label={`Posting times for ${label}`}>
                  {times.map((time) => (
                    <li
                      key={time}
                      className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface pl-2 pr-1 py-1 text-sm"
                    >
                      <Icon name="clock" size={13} className="text-mute" aria-hidden="true" />
                      <span className="tabular-nums">{time}</span>
                      <button
                        type="button"
                        onClick={() => removeTime(day, time)}
                        aria-label={`Remove ${time} on ${label}`}
                        className="rounded-md p-0.5 text-mute transition-colors hover:text-danger active:text-danger"
                      >
                        <Icon name="x" size={13} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex items-start gap-2">
                <Input
                  id={`${inputIdBase}-${key}`}
                  type="time"
                  step={60}
                  value={drafts[key] ?? ''}
                  onChange={(e) => {
                    const next = e.target.value;
                    setDrafts((prev) => ({ ...prev, [key]: next }));
                    if (invalid[key]) setInvalid((prev) => ({ ...prev, [key]: false }));
                  }}
                  aria-label={`Add a posting time for ${label}`}
                  aria-invalid={isInvalid || undefined}
                  error={isInvalid ? 'Enter a unique time as HH:mm' : undefined}
                  className="flex-1"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-11 shrink-0"
                  icon={<Icon name="plus" size={15} />}
                  onClick={() => addTime(day)}
                  aria-label={`Add time to ${label}`}
                >
                  Add
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <div
        role="status"
        aria-live="polite"
        className={cn(
          'flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-sm',
          overCap ? 'border-danger/40 bg-danger/10 text-danger' : 'border-line bg-app text-mute',
        )}
      >
        <Icon name={overCap ? 'alert' : 'clock'} size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
        <span>
          <b className={cn('font-semibold', overCap ? 'text-danger' : 'text-ink')}>
            {total} of {MAX_WEEKLY_POSTS} posts a week
          </b>
          {overCap && (
            <span className="block text-xs mt-0.5">
              Too many posts — remove at least {total - MAX_WEEKLY_POSTS} before saving.
            </span>
          )}
        </span>
      </div>
    </Card>
  );
}
