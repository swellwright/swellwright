import { ServiceUnavailableException } from '@nestjs/common';
import {
  type Permission,
  permissionsOf,
  type SessionInfo,
  type UserSummary,
} from '@swellwright/contracts';
import type { Database, User } from '@swellwright/db';
import type { Request } from 'express';

import { requestId } from '../http.js';

/** The session a request came with, resolved by the authentication guard. */
export interface AuthContext {
  readonly sessionId: string;
  readonly stage: 'password_verified' | 'active';
  readonly user: User;
  /** When the session ends if it stays idle. */
  readonly expiresAt: Date;
  /** The session counts as freshly verified until then (ADR 0017); null if it never was. */
  readonly elevatedUntil: Date | null;
  /**
   * The credential epoch the session was issued under (ADR 0049), as the guard saw it; null for a token. A mutation
   * re-reads the session under the account lock and requires the same epoch.
   */
  readonly sessionEpoch: bigint | null;
  /** A cookie session, or an API token (ADR 0023). A token has no session and no second factor. */
  readonly via: 'session' | 'token';
  readonly tokenId: string | null;
  /** For a token: what it may do now (its permissions as far as the owner's role allows). Null for a session. */
  readonly grants: readonly Permission[] | null;
}

export type AuthedRequest = Request & { auth?: AuthContext };

/** The guard has resolved the session by the time a handler runs; this narrows the type. */
export function requireAuth(req: AuthedRequest): AuthContext {
  if (!req.auth) {
    throw new Error('The authentication guard did not run for this route.');
  }
  return req.auth;
}

export interface RequestMeta {
  readonly ip: string | undefined;
  readonly userAgent: string | undefined;
  /** The id the request carries through logs and the audit chain. */
  readonly requestId: string | undefined;
}

export function requestMeta(req: Request): RequestMeta {
  const userAgent = req.get('user-agent');
  return {
    ip: req.ip,
    userAgent: userAgent?.slice(0, 256),
    requestId: req.res ? requestId(req.res) : undefined,
  };
}

/** The sign-in routes need the database; without one the API answers 503 like a failing readiness probe. */
export function requireDatabase(database: Database | undefined): Database {
  if (!database) {
    throw new ServiceUnavailableException('The database is not configured.');
  }
  return database;
}

export function toUserSummary(user: User): UserSummary {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    language: user.language,
    theme: user.theme,
  };
}

/** The user and what the role allows, as the console needs them after a sign-in and on every reload. */
export function toSessionInfo(
  user: User,
  expiresAt: Date,
  grants?: readonly Permission[] | null,
): SessionInfo {
  return {
    user: toUserSummary(user),
    permissions: [...(grants ?? permissionsOf(user.role))],
    expiresAt: expiresAt.toISOString(),
  };
}
