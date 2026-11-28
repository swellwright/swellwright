import { Body, Controller, Inject, Req, Res } from '@nestjs/common';
import {
  acceptInvitationRoute,
  type AcceptInvitationRequest,
  changePasswordRoute,
  type ChangePasswordRequest,
  type Elevation,
  loginRoute,
  logoutRoute,
  meRoute,
  stepUpRoute,
  type LoginRequest,
  type PendingSession,
  type SessionInfo,
  totpConfirmRoute,
  totpEnrollmentRoute,
  totpRoute,
  type TotpCodeRequest,
  type TotpConfirmed,
  type TotpEnrollment,
} from '@swellwright/contracts';
import type { Request, Response } from 'express';

import { type AppConfig } from '../config.js';
import { ContractRoute } from '../contract-route.js';
import { CONFIG } from '../tokens.js';
import { InvitationService } from '../users/invitation.service.js';
import { AuthService } from './auth.service.js';
import { type AuthedRequest, requestMeta, requireAuth, toSessionInfo } from './context.js';
import { clearSessionCookie, readCookie, SESSION_COOKIE, setSessionCookie } from './cookies.js';
import { hashToken, newSessionToken } from './tokens.js';

@Controller()
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(InvitationService) private readonly invitations: InvitationService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @ContractRoute(stepUpRoute)
  async stepUp(@Body() body: TotpCodeRequest, @Req() req: AuthedRequest): Promise<Elevation> {
    const { elevatedUntil } = await this.auth.stepUp(requireAuth(req), body.code, requestMeta(req));
    return { elevatedUntil: elevatedUntil.toISOString() };
  }

  @ContractRoute(acceptInvitationRoute)
  async acceptInvitation(
    @Body() body: AcceptInvitationRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PendingSession> {
    const { session } = await this.invitations.accept(body.token, body.password, requestMeta(req));
    setSessionCookie(res, session.token, this.config);
    // A new or reset account has no authenticator: the next step is to set one up.
    return { next: 'totp_enrollment' };
  }

  @ContractRoute(changePasswordRoute)
  async changePassword(
    @Body() body: ChangePasswordRequest,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    await this.auth.changePassword(
      requireAuth(req),
      body.currentPassword,
      body.newPassword,
      requestMeta(req),
    );
  }

  @ContractRoute(loginRoute)
  async login(
    @Body() body: LoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PendingSession> {
    const { session, next } = await this.auth.login(body.username, body.password, requestMeta(req));
    setSessionCookie(res, session.token, this.config);
    return { next };
  }

  @ContractRoute(totpRoute)
  async totp(
    @Body() body: TotpCodeRequest,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionInfo> {
    // Keep the bearer token out of factor verification. Send it only after the transaction commits.
    const token = newSessionToken();
    const { expiresAt, user } = await this.auth.verifySecondStep(
      requireAuth(req),
      body.code,
      requestMeta(req),
      hashToken(token),
    );
    setSessionCookie(res, token, this.config);
    return toSessionInfo(user, expiresAt);
  }

  @ContractRoute(totpEnrollmentRoute)
  enrollment(@Req() req: AuthedRequest): Promise<TotpEnrollment> {
    return this.auth.startEnrollment(requireAuth(req), requestMeta(req));
  }

  @ContractRoute(totpConfirmRoute)
  async confirm(
    @Body() body: TotpCodeRequest,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TotpConfirmed> {
    const token = newSessionToken();
    const { expiresAt, user, recoveryCodes } = await this.auth.confirmEnrollment(
      requireAuth(req),
      body.code,
      requestMeta(req),
      hashToken(token),
    );
    setSessionCookie(res, token, this.config);
    return {
      ...toSessionInfo(user, expiresAt),
      recoveryCodes: [...recoveryCodes],
    };
  }

  @ContractRoute(logoutRoute)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = readCookie(req.header('cookie'), SESSION_COOKIE);
    if (token) {
      await this.auth.logout(token, requestMeta(req));
    }
    clearSessionCookie(res, this.config);
  }

  @ContractRoute(meRoute)
  me(@Req() req: AuthedRequest): SessionInfo {
    const auth = requireAuth(req);
    return toSessionInfo(auth.user, auth.expiresAt, auth.grants);
  }
}
