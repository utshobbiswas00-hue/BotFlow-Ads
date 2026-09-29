import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SUPPORT_USERNAME, SUPPORT_URL, type Paginated } from '@botflow/shared';
import { api, errMsg } from '../lib/api';
import { qk } from '../lib/queryClient';
import type { TicketRow } from '../lib/contracts';
import { fromNow, humanize } from '../lib/format';
import { PageHeader } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Textarea } from '../components/ui/Textarea';
import { StatusBadge } from '../components/ui/StatusBadge';
import { ErrorState, EmptyState } from '../components/ui/EmptyState';
import { ListSkeleton } from '../components/ui/Skeleton';
import { Icon } from '../components/ui/icons';
import { showToast } from '../store/uiStore';

const CATEGORIES = [
  { value: 'General', label: 'General question' },
  { value: 'Billing', label: 'Billing & payments' },
  { value: 'Channel', label: 'Channel issue' },
  { value: 'Campaign', label: 'Campaign issue' },
  { value: 'Bug', label: 'Bug report' },
];

export function SupportPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState('General');
  const [message, setMessage] = useState('');

  const tickets = useQuery({
    queryKey: qk.tickets,
    queryFn: (): Promise<Paginated<TicketRow>> => api.get<Paginated<TicketRow>>('/api/support/tickets', { page: 1, limit: 30 }),
  });

  const create = useMutation({
    mutationFn: (body: { subject: string; category: string; message: string }): Promise<unknown> =>
      api.post('/api/support/tickets', body),
    onSuccess: () => {
      showToast('success', 'Support ticket created — we usually reply within 24h');
      setOpen(false);
      setSubject('');
      setMessage('');
      setCategory('General');
      void qc.invalidateQueries({ queryKey: qk.tickets });
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const submit = (): void => {
    if (subject.trim().length < 3 || message.trim().length < 10) {
      showToast('error', 'Subject and a short description (10+ chars) are required');
      return;
    }
    create.mutate({ subject: subject.trim(), category, message: message.trim() });
  };

  const items = tickets.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Support"
        subtitle="We're here to help"
        actions={
          <Button size="sm" icon={<Icon name="plus" size={15} />} onClick={() => setOpen(true)}>
            New
          </Button>
        }
      />

      {/* Direct contact, offered alongside the ticket flow. A ticket keeps the
          history attached to the account; some people would rather just message
          a human, so both routes are one tap away. */}
      <a
        href={SUPPORT_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-3 flex items-center gap-3 bg-surface border border-line rounded-2xl p-4 active:opacity-80"
      >
        <span className="w-10 h-10 rounded-xl bg-accent/10 text-accent flex items-center justify-center shrink-0">
          <Icon name="doc" size={20} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm">Chat with support</p>
          <p className="text-xs text-mute truncate">@{SUPPORT_USERNAME} on Telegram</p>
        </div>
        <Icon name="chevronRight" size={18} className="text-mute" />
      </a>

      <div className="mt-4">
        {tickets.isLoading ? (
          <ListSkeleton rows={3} />
        ) : tickets.isError ? (
          <ErrorState message={errMsg(tickets.error)} onRetry={() => void tickets.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon="doc"
            title="No tickets yet"
            message="Something wrong or a question? Open a ticket and our team will get back to you."
            action={
              <Button size="sm" icon={<Icon name="plus" size={15} />} onClick={() => setOpen(true)}>
                New ticket
              </Button>
            }
          />
        ) : (
          <div className="space-y-3">
            {items.map((t) => (
              <Link key={t.id} to={`/support/${t.id}`} className="block bg-surface border border-line rounded-2xl p-4 active:opacity-80">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold text-sm truncate">{t.subject}</p>
                  <StatusBadge status={t.status} />
                </div>
                <p className="text-xs text-mute mt-1">
                  #{t.ticketNo} · {humanize(t.category ?? 'general')} · {fromNow(t.lastMessageAt)}
                </p>
              </Link>
            ))}
          </div>
        )}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="New support ticket">
        <div className="space-y-3">
          <Input
            label="Subject"
            placeholder="Short summary of the issue"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={100}
          />
          <Select label="Category" value={category} onChange={(e) => setCategory(e.target.value)} options={CATEGORIES} />
          <Textarea
            label="Describe the issue"
            placeholder="What happened? Include campaign/channel IDs if relevant."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
          />
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" full onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button full loading={create.isPending} onClick={submit}>
              Send
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
