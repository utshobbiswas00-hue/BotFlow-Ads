import { useEffect, useRef, useState } from 'react';
import { useAiHistory, useSendAiMessage } from '../../hooks/useAiChat';
import { Spinner } from '../ui/Spinner';
import { cn } from '../../lib/cn';
import type { AiChatToolCall } from '../../lib/contracts';

/**
 * Floating AI Assistant.
 *
 * Mounted ONCE, inside AppShell, after <Outlet/> — so it is a sibling of every
 * page rather than a child of any of them. React Router keeps AppShell mounted
 * across navigations, which is what makes the conversation (and an open drawer)
 * survive moving between screens.
 *
 * The whole thing talks to `/api/ai/*` through the hooks; there is no LLM key in
 * this deployment, so the header says the reply comes from tool calls.
 */

const LIVE = import.meta.env.VITE_AI_LIVE === '1';

/** Tool results are JSON blobs; the panel shows at most the first 200 chars. */
function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function ToolCallDetails({ calls }: { calls: AiChatToolCall[] }) {
  const [open, setOpen] = useState(false);
  if (calls.length === 0) return null;

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="text-[11px] font-medium text-link underline underline-offset-2"
      >
        {open ? 'Hide details' : 'Show details'}
      </button>
      {open && (
        <ul className="mt-1 space-y-1">
          {calls.map((c, i) => (
            <li key={`${c.name}-${i}`} className="rounded-lg bg-black/5 px-2 py-1.5">
              <p className="text-[11px] font-semibold">{c.name}</p>
              <p className="text-[11px] text-mute break-words">{truncate(c.result)}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function FloatingChatWidget() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const history = useAiHistory();
  const send = useSendAiMessage();
  const endRef = useRef<HTMLDivElement | null>(null);

  const messages = history.data ?? [];

  // Auto-scroll to the newest turn (and while the assistant is thinking).
  useEffect(() => {
    if (!open) return;
    endRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [open, messages.length, send.isPending]);

  const canSend = draft.trim().length > 0 && !send.isPending;

  const handleSend = (): void => {
    const text = draft.trim();
    if (!text || send.isPending) return;
    setDraft('');
    send.mutate(text);
  };

  return (
    <>
      {!open && (
        <button
          type="button"
          aria-label="Open BotFlow Assistant"
          className="bf-chat-bubble"
          onClick={() => setOpen(true)}
        >
          {/* chat bubble glyph */}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M21 12a8 8 0 0 1-8 8H8l-4 3v-4.2A8 8 0 0 1 5.2 6.3 8 8 0 0 1 13 4a8 8 0 0 1 8 8Z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}

      {open && (
        <section role="dialog" aria-label="BotFlow Assistant" className="bf-chat-drawer">
          <header className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold leading-tight">BotFlow Assistant</h2>
              {!LIVE && <p className="text-[11px] text-mute">powered by tool calls</p>}
            </div>
            <button
              type="button"
              aria-label="Close assistant"
              onClick={() => setOpen(false)}
              className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-mute active:opacity-70"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3" data-testid="bf-chat-messages">
            {history.isLoading && (
              <div className="flex justify-center py-4">
                <Spinner />
              </div>
            )}

            {!history.isLoading && messages.length === 0 && (
              <p className="text-xs text-mute text-center py-6">
                Ask me about your balance, channels or earnings.
              </p>
            )}

            {messages.map((m) => (
              <div key={m.id} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div
                  className={cn(
                    'max-w-[85%] rounded-2xl px-3 py-2 text-sm',
                    m.role === 'user' ? 'bf-chat-msg-user' : 'bf-chat-msg-assistant',
                  )}
                >
                  <p className="whitespace-pre-wrap break-words">{m.content}</p>
                  {m.role === 'assistant' && m.toolCalls.length > 0 && (
                    <ToolCallDetails calls={m.toolCalls} />
                  )}
                </div>
              </div>
            ))}

            {send.isPending && (
              <div className="flex justify-start">
                <div className="bf-chat-msg-assistant rounded-2xl px-3 py-2">
                  <Spinner size={16} />
                </div>
              </div>
            )}

            <div ref={endRef} />
          </div>

          <form
            className="border-t border-line p-3 flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              rows={1}
              placeholder="Ask about your balance, channels…"
              aria-label="Message"
              className="flex-1 resize-none max-h-24 rounded-xl border border-line bg-app px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send"
              className="shrink-0 h-9 px-3 rounded-xl font-semibold text-sm disabled:opacity-40"
              style={{ backgroundColor: '#0386FA', color: '#fff' }}
            >
              Send
            </button>
          </form>
        </section>
      )}
    </>
  );
}
