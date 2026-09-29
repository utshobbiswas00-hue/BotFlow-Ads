import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { qk } from '../lib/queryClient';
import type { TicketDetail as TicketDetailT } from '../lib/contracts';
import { formatDateTime, humanize } from '../lib/format';
import { PageHeader } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { StatusBadge } from '../components/ui/StatusBadge';
import { PageSkeleton } from '../components/ui/Skeleton';
import { ErrorState } from '../components/ui/EmptyState';
import { cn } from '../lib/cn';
import { showToast } from '../store/uiStore';

export function TicketDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [reply, setReply] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const q = useQuery({
    queryKey: qk.ticket(id ?? ''),
    enabled: !!id,
    queryFn: (): Promise<TicketDetailT> => api.get<TicketDetailT>(`/api/support/tickets/${id}`),
  });

  const send = useMutation({
    mutationFn: (body: { message: string }): Promise<unknown> => api.post(`/api/support/tickets/${id}/messages`, body),
    onSuccess: () => {
      setReply('');
      void qc.invalidateQueries({ queryKey: qk.ticket(id ?? '') });
      void qc.invalidateQueries({ queryKey: qk.tickets });
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 60);
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  useEffect(() => {
    if (q.data) bottomRef.current?.scrollIntoView();
  }, [q.data]);

  if (q.isPending) return <PageSkeleton />;
  if (q.isError || !q.data)
    return (
      <>
        <PageHeader title="Ticket" back />
        <ErrorState message={errMsg(q.error)} onRetry={() => void q.refetch()} />
      </>
    );

  const { ticket, messages = [] } = q.data;
  const closed = ticket.status === 'CLOSED' || ticket.status === 'RESOLVED';

  return (
    <>
      <PageHeader
        title={`#${ticket.ticketNo}`}
        subtitle={ticket.subject}
        back
        actions={<StatusBadge status={ticket.status} />}
      />

      <div className="mt-2 space-y-3">
        {ticket.category && (
          <p className="text-xs text-mute">Category: {humanize(ticket.category)}</p>
        )}

        <Card padded={false} className="space-y-0">
          {messages.map((m) => {
            const mine = m.senderType === 'USER';
            return (
              <div key={m.id} className={cn('flex px-3.5 py-3', m.senderType === 'AGENT' && 'bg-app/60')}>
                <div className={cn('max-w-[85%]', mine ? 'ml-auto' : '')}>
                  <div
                    className={cn(
                      'rounded-2xl px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words',
                      mine ? 'bg-accent text-accentink rounded-br-md' : 'bg-surface border border-line rounded-bl-md',
                    )}
                  >
                    {m.body}
                  </div>
                  <p className={cn('text-[10px] text-mute mt-1', mine ? 'text-right' : '')}>
                    {mine ? 'You' : 'Support'} · {formatDateTime(m.createdAt)}
                  </p>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </Card>

        {closed ? (
          <Card>
            <p className="text-sm text-mute text-center">
              This ticket is {humanize(ticket.status.toLowerCase())}. Need more help?{' '}
              <span className="text-link font-semibold">Open a new ticket</span> from the Support page.
            </p>
          </Card>
        ) : (
          <div className="flex gap-2 pb-4">
            <Input
              placeholder="Write a reply…"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && reply.trim()) send.mutate({ message: reply.trim() });
              }}
              className="flex-1"
            />
            <Button
              loading={send.isPending}
              disabled={reply.trim().length === 0}
              onClick={() => send.mutate({ message: reply.trim() })}
            >
              Send
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
