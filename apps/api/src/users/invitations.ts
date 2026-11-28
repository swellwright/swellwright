import type { Invitation } from '@swellwright/contracts';
import type { PrismaClient } from '@swellwright/db';

import { hashToken, newSessionToken } from '../auth/tokens.js';

/** How long an invitation works (ADR 0016). */
export const INVITATION_TTL_MS = 72 * 3_600_000;

/** The part of a Prisma client that can take part in a transaction the caller already has. */
export type InvitationWriter = Pick<PrismaClient, 'invitation'>;

/**
 * Makes the one open invitation of a user, replacing any earlier one. The token is returned once; only its hash is
 * stored. Only this user's row is touched, so the caller's account lock covers everything it writes; expired rows of
 * other accounts are removed by `pruneExpiredInvitations`, outside it.
 */
export async function issueInvitation(
  tx: InvitationWriter,
  userId: string,
  purpose: Invitation['purpose'],
  createdById: string | null,
  now: Date = new Date(),
): Promise<Invitation> {
  const token = newSessionToken();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
  await tx.invitation.deleteMany({ where: { userId } });
  await tx.invitation.create({
    data: { userId, tokenHash: hashToken(token), purpose, expiresAt, createdById },
  });
  return { token, expiresAt: expiresAt.toISOString(), purpose };
}

/** Removes the invitations of every account that ran out. Never inside an account's transaction. */
export async function pruneExpiredInvitations(
  db: InvitationWriter,
  now: Date = new Date(),
): Promise<void> {
  await db.invitation.deleteMany({ where: { expiresAt: { lt: now } } });
}
