import type { AdminRole } from '@prisma/client';

/** The authenticated Telegram user attached to every request. */
export interface AuthUser {
  id: string;
  telegramId: string;
  username: string | null;
  status: string;
  isAdvertiser: boolean;
  isPublisher: boolean;
}

/** Admin identity, present only when the caller has an AdminUser row. */
export interface AuthAdmin {
  id: string;
  role: AdminRole;
  permissions: string[];
}

export interface RequestContext {
  requestId: string;
  ip: string;
  userAgent: string;
  startedAt: number;
}
