import type { Prisma, ReportReason, ReportStatus } from '@prisma/client';
import { prisma } from '../db/prisma';
import { buildPaginated, type Pagination } from '../utils/pagination';
import { ConflictError, NotFoundError } from '../utils/errors';
import { displayName } from '../utils/format';
import { recordAudit } from './audit.service';
import { logger } from '../config/logger';

/**
 * User reports against ad posts (scam / spam / broken link / ...).
 */

export interface CreateReportInput {
  adPostId: string;
  reason: ReportReason;
  details?: string | null;
}

export interface ReportRow {
  id: string;
  reporterName: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  createdAt: Date;
}

/**
 * File a report against a live ad post. The report is linked to the post's
 * campaign so admins can see all reports per campaign in one place.
 */
export async function createReport(userId: string, input: CreateReportInput) {
  const adPost = await prisma.adPost.findUnique({
    where: { id: input.adPostId },
    select: { id: true, campaignId: true },
  });
  if (!adPost) throw new NotFoundError('Ad post');

  const report = await prisma.report.create({
    data: {
      reporterId: userId,
      adPostId: adPost.id,
      campaignId: adPost.campaignId,
      reason: input.reason,
      details: input.details ?? null,
    },
  });

  logger.info(
    { reportId: report.id, adPostId: report.adPostId, reason: report.reason, reporterId: userId },
    'ad post reported',
  );

  return report;
}

/* ------------------------------------------------------------------
 *  Admin: list & resolve
 * ------------------------------------------------------------------ */

export interface ListReportsFilter {
  status?: ReportStatus;
}

export async function listReports(filter: ListReportsFilter, p: Pagination) {
  const where: Prisma.ReportWhereInput = {
    ...(filter.status ? { status: filter.status } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.report.count({ where }),
    prisma.report.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: p.skip,
      take: p.take,
      select: {
        id: true,
        reason: true,
        details: true,
        status: true,
        createdAt: true,
        reporter: { select: { firstName: true, lastName: true, username: true } },
      },
    }),
  ]);

  const rows: ReportRow[] = items.map((r) => ({
    id: r.id,
    reporterName: displayName(r.reporter),
    reason: r.reason,
    details: r.details,
    status: r.status,
    createdAt: r.createdAt,
  }));

  return buildPaginated(rows, total, p);
}

/**
 * Close out a report. RESOLVE means the issue was acted on; DISMISS means no
 * action was needed. A report can only be resolved once.
 */
export async function resolveReport(
  adminId: string,
  reportId: string,
  action: 'RESOLVE' | 'DISMISS',
  actionTaken?: string,
) {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) throw new NotFoundError('Report');

  if (report.status === 'RESOLVED' || report.status === 'DISMISSED') {
    throw new ConflictError(`This report is already ${report.status.toLowerCase()}`);
  }

  const status: ReportStatus = action === 'RESOLVE' ? 'RESOLVED' : 'DISMISSED';

  // Conditional write (CAS): the status check above is a read-then-write, so
  // two admins resolving the same report at once could both pass it. Only the
  // first UPDATE finds the report still open.
  const res = await prisma.report.updateMany({
    where: { id: reportId, status: { notIn: ['RESOLVED', 'DISMISSED'] } },
    data: {
      status,
      reviewedById: adminId,
      reviewedAt: new Date(),
      actionTaken: actionTaken ?? null,
    },
  });
  if (res.count === 0) {
    throw new ConflictError(`This report is already ${report.status.toLowerCase()}`);
  }

  const updated = await prisma.report.findUnique({ where: { id: reportId } });
  if (!updated) throw new NotFoundError('Report');

  await recordAudit({
    actorId: adminId,
    actorType: 'ADMIN',
    action: action === 'RESOLVE' ? 'REPORT_RESOLVED' : 'REPORT_DISMISSED',
    targetType: 'REPORT',
    targetId: reportId,
    oldValue: { status: report.status },
    newValue: { status, actionTaken: actionTaken ?? null },
  });

  logger.info({ reportId, action, adminId }, 'report closed out');

  return updated;
}
