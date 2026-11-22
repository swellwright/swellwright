import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import {
  type AuditDetails,
  type PanelConsoleCatalogue,
  type PanelConsoleOperation,
  type PanelConsoleOperationDetail,
  type PanelConsoleRequest,
  type PanelConsoleResult,
} from '@swellwright/contracts';
import {
  type ConsoleOperation,
  consoleCatalogue,
  ConsoleRequestError,
  type ConsoleResult,
  PanelError,
  type PreparedConsoleRequest,
  prepareConsoleRequest,
} from '@swellwright/remnawave';

import { AuditService } from '../../audit/audit.service.js';
import { type AuthContext, type RequestMeta } from '../../auth/context.js';
import { can } from '../../auth/guards.js';
import { WindowLimiter } from '../../auth/rate-limit.js';
import { type AppConfig } from '../../config.js';
import { CodedHttpException, RateLimitedException, StepUpRequiredException } from '../../http.js';
import { CONFIG } from '../../tokens.js';
import { VaultService } from '../../vault/vault.service.js';
import { PanelClients } from '../clients.js';
import { type ConnectionRow } from '../connection-view.js';
import { panelException } from '../panel-errors.js';
import { PanelService } from '../panel.service.js';

/** A user who keeps asking for what is refused fills the audit chain, which is never pruned: cap it like `authz.denied`. */
const DENIED_NOTES_PER_USER = 20;
const DENIED_WINDOW_MS = 10 * 60_000;

/** An arbitrary text for the audit record, fitted to the width of a detail. */
const fit = (text: string): string => text.slice(0, 200);

/**
 * The API console (ADR 0046): the catalogue of the panel's operations, and the one place that sends a request of it.
 * Every request is a GET of an operation of the catalogue, to the connected panel, with the token from the vault read for
 * this request only. What comes back is masked by the client of the package before it is returned here. The checks
 * come in this order, so that a refusal never says more than the caller may know: the operation exists, it may be sent
 * at all, the installation allows its class, the caller may and has proved the second factor, the request fits the
 * operation, this user is within the limit, and only then is the panel asked.
 */
@Injectable()
export class PanelConsoleService {
  private readonly limiter: WindowLimiter;
  private readonly deniedNotes = new WindowLimiter(DENIED_NOTES_PER_USER, DENIED_WINDOW_MS);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PanelService) private readonly panel: PanelService,
    @Inject(VaultService) private readonly vault: VaultService,
    @Inject(PanelClients) private readonly clients: PanelClients,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.limiter = new WindowLimiter(config.panel.console.ratePerMinute, 60_000);
  }

  // ---- the catalogue ----------------------------------------------------------------------------------------------

  catalogue(): PanelConsoleCatalogue {
    const catalogue = consoleCatalogue();
    return {
      specVersion: catalogue.specVersion,
      settings: {
        userDataEnabled: this.config.panel.console.userData,
        ratePerMinute: this.config.panel.console.ratePerMinute,
        maxBodyKib: Math.round(this.config.panel.console.maxBodyBytes / 1024),
      },
      counts: catalogue.counts,
      // The catalogue is data that is never changed; the contract types its arrays as mutable.
      operations: catalogue.operations as PanelConsoleOperation[],
    };
  }

  operation(operationId: string): PanelConsoleOperationDetail {
    const detail = consoleCatalogue().detail(operationId);
    if (!detail) {
      throw unknownOperation();
    }
    return detail as PanelConsoleOperationDetail;
  }

  // ---- sending ---------------------------------------------------------------------------------------------------

  async send(
    auth: AuthContext,
    request: PanelConsoleRequest,
    meta: RequestMeta,
  ): Promise<PanelConsoleResult> {
    const actor = { id: auth.user.id, name: auth.user.username };
    const operation = consoleCatalogue().find(request.operationId);
    if (!operation) {
      throw unknownOperation();
    }
    await this.checkPolicy(auth, actor, operation, meta);
    const prepared = this.prepare(operation, request);
    if (!this.limiter.hit(actor.id)) {
      throw new RateLimitedException(
        60,
        'Too many requests from the console. Try again in a minute.',
      );
    }
    const row = await this.panel.requireRow();
    if (row.state === 'unsupported') {
      throw new CodedHttpException(
        409,
        'panel_unsupported_version',
        row.lastErrorMessage ?? 'The panel runs a version this release does not support.',
        { version: row.panelVersion },
      );
    }
    const token = await this.vault.readForPanel(row.tokenSecretId, row.id);
    const client = this.clients.createConsole(
      { baseUrl: row.baseUrl, trustedCa: row.trustedCa },
      token,
    );
    let result: ConsoleResult;
    try {
      result = await client.send(prepared);
    } catch (error) {
      if (error instanceof PanelError) {
        await this.panel.noteReadFailure(row, error);
        await this.recordFailure(actor, row, operation, prepared, error, meta);
        throw panelException(error);
      }
      throw error;
    } finally {
      client.close();
    }
    await this.panel.noteReadSuccess(row);
    const personal = operation.availability === 'user_data';
    await this.recordSuccess(actor, row, operation, prepared, result, personal, meta);
    return {
      operationId: operation.operationId,
      method: 'get',
      path: operation.path,
      status: result.status,
      durationMs: Math.round(result.durationMs),
      attempts: result.attempts,
      headers: { ...result.headers },
      contentType: result.contentType,
      bodyFormat: result.bodyFormat,
      body: result.body,
      bodyBytes: result.bodyBytes,
      truncated: result.truncated,
      masked: result.maskedCount > 0,
      maskedCount: result.maskedCount,
      maskProfile: personal ? 'personal' : 'standard',
      sentAt: new Date().toISOString(),
    };
  }

  /** Whether this operation may be sent at all, and by this caller. Throws the refusal; records it (capped). */
  private async checkPolicy(
    auth: AuthContext,
    actor: { id: string; name: string },
    operation: ConsoleOperation,
    meta: RequestMeta,
  ): Promise<void> {
    if (operation.availability === 'write' || operation.availability === 'blocked') {
      const reason =
        operation.availability === 'write' ? 'write_operation' : operation.blockedReason;
      await this.denied(actor, operation, `blocked_${reason ?? 'unknown'}`, meta);
      throw new CodedHttpException(
        403,
        'console_operation_blocked',
        operation.availability === 'write'
          ? 'This console only reads. Operations that change the panel arrive with the approvals of a later release.'
          : reason === 'side_effect'
            ? 'This operation creates something on the panel when it is asked for, so the console does not send it.'
            : 'This operation returns a key or a link that works as a credential, so the console does not send it.',
        { operationId: operation.operationId, reason },
      );
    }
    if (operation.availability !== 'user_data') {
      return;
    }
    if (!this.config.panel.console.userData) {
      await this.denied(actor, operation, 'user_data_disabled', meta);
      throw new CodedHttpException(
        403,
        'console_user_data_disabled',
        'This operation reads data about the people who use the panel. It is off on this installation: set SW_PANEL_CONSOLE_USER_DATA=true to allow it.',
        { operationId: operation.operationId },
      );
    }
    if (!can(auth, 'vault:reveal')) {
      await this.denied(actor, operation, 'needs_vault_reveal', meta);
      throw new ForbiddenException(
        'Reading data about the people who use the panel needs the permission to reveal secrets as well.',
      );
    }
    // The second factor, checked here and not on the route: only these operations need it, the rest of the console must
    // not ask for a code every few minutes.
    if (!auth.elevatedUntil || auth.elevatedUntil.getTime() <= Date.now()) {
      throw new StepUpRequiredException();
    }
  }

  private prepare(
    operation: ConsoleOperation,
    request: PanelConsoleRequest,
  ): PreparedConsoleRequest {
    try {
      return prepareConsoleRequest(operation, {
        pathParams: request.pathParams,
        query: request.query,
      });
    } catch (error) {
      if (error instanceof ConsoleRequestError) {
        throw new CodedHttpException(400, 'validation_failed', error.message, {
          issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        });
      }
      throw error;
    }
  }

  // ---- the record ------------------------------------------------------------------------------------------------

  private details(
    operation: ConsoleOperation,
    prepared: PreparedConsoleRequest,
    more: AuditDetails,
  ): AuditDetails {
    return {
      operation_id: fit(operation.operationId),
      path: fit(operation.path),
      // The names of the query parameters, never their values, and no value of a path parameter at all.
      query_keys: fit(prepared.queryKeys.join(',')),
      about_people: operation.availability === 'user_data',
      ...more,
    };
  }

  private async recordSuccess(
    actor: { id: string; name: string },
    row: ConnectionRow,
    operation: ConsoleOperation,
    prepared: PreparedConsoleRequest,
    result: ConsoleResult,
    personal: boolean,
    meta: RequestMeta,
  ): Promise<void> {
    const input = {
      action: 'panel.console.request',
      outcome: 'success',
      actor,
      object: { type: 'panel', id: row.id },
      details: this.details(operation, prepared, {
        status: result.status,
        duration_ms: Math.round(result.durationMs),
        masked_count: result.maskedCount,
        truncated: result.truncated,
        bytes: result.bodyBytes,
      }),
      meta,
    } as const;
    // What is about the people who use the panel is not delivered unless it is on the record: a failure to write it fails
    // the request. A read of the panel's own objects is not a change, and a note is enough.
    if (personal) {
      await this.audit.record(input);
    } else {
      await this.audit.note(input);
    }
  }

  private async recordFailure(
    actor: { id: string; name: string },
    row: ConnectionRow,
    operation: ConsoleOperation,
    prepared: PreparedConsoleRequest,
    error: PanelError,
    meta: RequestMeta,
  ): Promise<void> {
    await this.audit.note({
      action: 'panel.console.request',
      outcome: 'failure',
      actor,
      object: { type: 'panel', id: row.id },
      details: this.details(operation, prepared, { error_code: error.code }),
      meta,
    });
  }

  private async denied(
    actor: { id: string; name: string },
    operation: ConsoleOperation,
    why: string,
    meta: RequestMeta,
  ): Promise<void> {
    if (!this.deniedNotes.hit(actor.id)) {
      return;
    }
    await this.audit.note({
      action: 'panel.console.request',
      outcome: 'denied',
      actor,
      object: { type: 'panel', id: 'console' },
      details: {
        operation_id: fit(operation.operationId),
        path: fit(operation.path),
        reason: why,
      },
      meta,
    });
  }
}

function unknownOperation(): CodedHttpException {
  return new CodedHttpException(
    404,
    'console_operation_unknown',
    "There is no such operation in the catalogue of the panel's API.",
  );
}
