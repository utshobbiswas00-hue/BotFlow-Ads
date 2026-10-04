import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { FloatingChatWidget } from '../components/ai/FloatingChatWidget';
import { AppShell } from '../components/layout/AppShell';

/**
 * FloatingChatWidget.
 *
 * The chat hooks and the session bootstrap are mocked — this test is about the
 * WIDGET (bubble → drawer, send-on-enter, the tool-call details), not about
 * axios or a backend. The second block proves the widget is mounted by AppShell
 * itself, i.e. it renders on the dashboard route without any page opting in.
 */
const { mutateMock, historyRef } = vi.hoisted(() => ({
  mutateMock: vi.fn(),
  historyRef: { current: [] as Array<Record<string, unknown>> },
}));

vi.mock('../hooks/useAiChat', () => ({
  useAiHistory: () => ({ data: historyRef.current, isLoading: false, isError: false }),
  useSendAiMessage: () => ({ mutate: mutateMock, isPending: false }),
}));

vi.mock('../hooks/useTelegramUser', () => ({
  useTelegramUser: () => ({
    data: { user: null, wallet: null, isAdmin: false, adminRole: null },
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

function renderWidget() {
  return render(
    <MemoryRouter>
      <FloatingChatWidget />
    </MemoryRouter>,
  );
}

function openDrawer() {
  fireEvent.click(screen.getByRole('button', { name: /open botflow assistant/i }));
}

const ASSISTANT_WITH_TOOLS = {
  id: '2',
  role: 'assistant',
  content: 'Your balance is 500.',
  ts: 2,
  toolCalls: [{ name: 'get_wallet', args: {}, result: '{"availableCents":500}' }],
};

afterEach(() => {
  cleanup();
  mutateMock.mockClear();
  historyRef.current = [];
});

describe('FloatingChatWidget', () => {
  it('renders the bubble and keeps the drawer closed until it is clicked', () => {
    renderWidget();

    expect(screen.getByRole('button', { name: /open botflow assistant/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the drawer with header, subtitle and history, and closes with X', () => {
    historyRef.current = [
      { id: '1', role: 'user', content: 'Hi', ts: 1, toolCalls: [] },
      ASSISTANT_WITH_TOOLS,
    ];

    renderWidget();
    openDrawer();

    const dialog = screen.getByRole('dialog', { name: /botflow assistant/i });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('BotFlow Assistant')).toBeInTheDocument();
    expect(screen.getByText(/powered by tool calls/i)).toBeInTheDocument();
    expect(screen.getByText('Your balance is 500.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /close assistant/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The bubble comes back so the drawer can be reopened.
    expect(screen.getByRole('button', { name: /open botflow assistant/i })).toBeInTheDocument();
  });

  it('sends the typed message on Enter', () => {
    renderWidget();
    openDrawer();

    const input = screen.getByLabelText('Message');
    fireEvent.change(input, { target: { value: "what's my balance" } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock).toHaveBeenCalledWith("what's my balance");
  });

  it('disables send until there is text, then sends on click', () => {
    renderWidget();
    openDrawer();

    const sendBtn = screen.getByRole('button', { name: /^send$/i });
    expect(sendBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hi' } });
    expect(sendBtn).not.toBeDisabled();

    fireEvent.click(sendBtn);
    expect(mutateMock).toHaveBeenCalledWith('hi');
  });

  it('renders a collapsible tool-call panel for assistant messages', () => {
    historyRef.current = [ASSISTANT_WITH_TOOLS];

    renderWidget();
    openDrawer();

    // Collapsed by default.
    expect(screen.getByText('Show details')).toBeInTheDocument();
    expect(screen.queryByText('get_wallet')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Show details'));

    // The tool name and (truncated) result are revealed.
    expect(screen.getByText('get_wallet')).toBeInTheDocument();
    expect(screen.getByText(/"availableCents":500/)).toBeInTheDocument();
  });
});

describe('AppShell mounts the assistant', () => {
  it('renders the widget on the dashboard route (/)', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<div>Dashboard page</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Dashboard page')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open botflow assistant/i })).toBeInTheDocument();
  });
});

describe('FloatingChatWidget — visibility', () => {
  it('bubble has position:fixed inline so it floats above page content', () => {
    render(
      <MemoryRouter>
        <FloatingChatWidget />
      </MemoryRouter>,
    );
    const bubble = screen.getByRole('button', { name: /Open BotFlow Assistant/i });
    // Inline style attributes win over CSS class purging, which is exactly
    // why this widget sets them. If anyone reverts to className-only, the
    // assertion below will fail in jsdom (no Tailwind compile).
    expect(bubble.style.position).toBe('fixed');
    // z-index must be high enough to clear the bottom nav (which is z-40).
    const zi = Number(bubble.style.zIndex);
    expect(Number.isFinite(zi) && zi >= 50).toBe(true);
  });

  it('drawer also uses position:fixed when opened', async () => {
    render(
      <MemoryRouter>
        <FloatingChatWidget />
      </MemoryRouter>,
    );
    const bubble = screen.getByRole('button', { name: /Open BotFlow Assistant/i });
    await fireEvent.click(bubble);
    const drawer = await screen.findByRole('dialog', { name: /BotFlow Assistant/i });
    expect(drawer.style.position).toBe('fixed');
  });
});
