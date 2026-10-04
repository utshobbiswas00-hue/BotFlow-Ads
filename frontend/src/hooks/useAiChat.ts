import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { qk } from '../lib/queryClient';
import type { AiChatMessage, AiChatReply, AiChatToolCall } from '../lib/contracts';

/**
 * AI Assistant hooks.
 *
 * The widget lives in AppShell, so these hooks are the single source of the
 * transcript: `useAiHistory` reads it, `useSendAiMessage` optimistically appends
 * the user's turn and then appends the assistant's reply from the server.
 *
 * The server stores `AiMessage` (role may be 'tool', no `id`); the UI works with
 * `AiChatMessage`. The assistant's tool-call trace is carried alongside the
 * message as an extra field (`AiChatMessageWithTools`) — it is a superset of the
 * contract type, so anything typed against `AiChatMessage` still works.
 */

export interface AiChatMessageWithTools extends AiChatMessage {
  /** Non-empty when this assistant turn was produced by tool calls. */
  toolCalls: AiChatToolCall[];
}

interface RawAiMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  ts?: number;
}

interface AiHistoryResponse {
  messages: RawAiMessage[];
}

function normalise(raw: RawAiMessage, index: number): AiChatMessageWithTools {
  const ts = raw.ts ?? Date.now() + index;
  return {
    id: `${ts}-${index}`,
    role: raw.role === 'assistant' ? 'assistant' : 'user',
    content: raw.content,
    ts,
    toolCalls: [],
  };
}

/** GET /api/ai/history — the persisted transcript, oldest first. */
export function useAiHistory() {
  return useQuery({
    queryKey: qk.aiHistory,
    queryFn: async (): Promise<AiChatMessageWithTools[]> => {
      const { messages } = await api.get<AiHistoryResponse>('/api/ai/history');
      return (messages ?? []).filter((m) => m.role !== 'tool').map(normalise);
    },
  });
}

/**
 * POST /api/ai/chat.
 *
 * onMutate appends the user's message immediately (the input clears the moment
 * they hit send); onSuccess appends the assistant reply with its tool-call
 * trace captured on the message so the widget can offer "Show details".
 */
export function useSendAiMessage() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (message: string): Promise<AiChatReply> =>
      api.post<AiChatReply>('/api/ai/chat', { message }),

    onMutate: async (message: string) => {
      await qc.cancelQueries({ queryKey: qk.aiHistory });
      const previous = qc.getQueryData<AiChatMessageWithTools[]>(qk.aiHistory) ?? [];

      const optimistic: AiChatMessageWithTools = {
        id: `local-${Date.now()}`,
        role: 'user',
        content: message,
        ts: Date.now(),
        toolCalls: [],
      };
      qc.setQueryData<AiChatMessageWithTools[]>(qk.aiHistory, [...previous, optimistic]);

      return { previous };
    },

    onError: (_err, _message, ctx) => {
      // Roll the optimistic user turn back so the transcript matches the server.
      if (ctx) qc.setQueryData(qk.aiHistory, ctx.previous);
    },

    onSuccess: (data, _message, ctx) => {
      const base = qc.getQueryData<AiChatMessageWithTools[]>(qk.aiHistory) ?? ctx?.previous ?? [];
      const assistant: AiChatMessageWithTools = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: data.reply,
        ts: Date.now(),
        toolCalls: data.toolCalls ?? [],
      };
      qc.setQueryData<AiChatMessageWithTools[]>(qk.aiHistory, [...base, assistant]);
    },
  });
}
