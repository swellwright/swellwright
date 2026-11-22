import { randomUUID } from 'node:crypto';

import {
  type ArgumentsHost,
  Catch,
  type CallHandler,
  type ExceptionFilter,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  type NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { ApiErrorSchema, type ErrorCode, type RouteDef } from '@swellwright/contracts';
import type { NextFunction, Request, Response } from 'express';
import { type Observable, tap } from 'rxjs';
import { ZodError } from 'zod';

import { ROUTE_METADATA } from './contract-route.js';

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/u;

export function requestId(res: Response): string {
  return typeof res.locals['requestId'] === 'string' ? res.locals['requestId'] : 'unknown';
}

/** Gives every request an id (a valid incoming `x-request-id` is kept) and sets safe API headers. */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const id = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.locals['requestId'] = id;
  res.setHeader('x-request-id', id);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', 'no-store');
  next();
}

const CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  423: 'vault_sealed',
  429: 'rate_limited',
  503: 'not_ready',
};

/**
 * 403 with its own error code: the caller may do this, but not with a session that has not proved the second
 * factor lately (ADR 0017). A client answers it by asking for a code and trying again.
 */
export class StepUpRequiredException extends HttpException {
  constructor() {
    super('Confirm with a code from your authenticator, then try again.', HttpStatus.FORBIDDEN);
  }
}

/** 423: the vault exists but its key is not in memory, so nothing that needs a secret can happen (ADR 0018). */
export class VaultSealedException extends HttpException {
  constructor() {
    super('The vault is sealed. Unseal it with the passphrase first.', HttpStatus.LOCKED);
  }
}

/**
 * An error with a code of its own and structured details, for the cases a client has to tell apart and act on: a
 * host key that changed, an address the policy refuses, a login that was not accepted (ADR 0037).
 */
export class CodedHttpException extends HttpException {
  constructor(
    status: number,
    readonly apiCode: ErrorCode,
    message: string,
    readonly apiDetails?: unknown,
    /** Sent as `Retry-After`, for an answer that tells the caller to wait (a panel that asks to slow down). */
    readonly retryAfterSeconds?: number,
  ) {
    super(message, status);
  }
}

/**
 * 409 `secret_expired`: the secret exists, but its expiry has passed, so nothing may use it (ADR 0042). It names the
 * secret by id and name (never the value) and says what to do. Every operation that uses a secret answers it in its own
 * envelope, as it does for the sealed vault: this one is already an API error, so the HTTP routes need nothing more.
 */
export class SecretExpiredException extends CodedHttpException {
  constructor(secret: { readonly id: string; readonly name: string; readonly expiresAt: Date }) {
    super(
      409,
      'secret_expired',
      `The secret "${secret.name}" expired on ${secret.expiresAt.toISOString().slice(0, 10)}. Renew its expiry or replace the secret, then try again.`,
      {
        secretId: secret.id,
        secretName: secret.name,
        expiresAt: secret.expiresAt.toISOString(),
      },
    );
  }
}

/** 429 with a `Retry-After` header. */
export class RateLimitedException extends HttpException {
  constructor(
    readonly retryAfterSeconds: number,
    message = 'Too many attempts. Try again later.',
  ) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** Turns every failure into the documented error envelope. Unexpected errors never leak their message. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const id = requestId(res);
    let status = 500;
    let code: ErrorCode = 'internal_error';
    let message = 'Internal error.';
    let details: unknown;

    if (exception instanceof ZodError) {
      status = 400;
      code = 'validation_failed';
      message = 'The request does not match the contract.';
      details = exception.issues;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = CODE_BY_STATUS[status] ?? (status >= 500 ? 'internal_error' : 'bad_request');
      message = status >= 500 ? 'Internal error.' : exception.message;
      if (exception instanceof RateLimitedException) {
        res.setHeader('retry-after', String(exception.retryAfterSeconds));
      }
      if (exception instanceof StepUpRequiredException) {
        code = 'step_up_required';
      }
      if (exception instanceof CodedHttpException) {
        if (exception.retryAfterSeconds !== undefined) {
          res.setHeader('retry-after', String(exception.retryAfterSeconds));
        }
        code = exception.apiCode;
        // A 5xx still says what went wrong: these are failures of a server out there, not of Swellwright.
        message = exception.message;
        details = exception.apiDetails;
      }
    } else {
      this.logger.error(
        `request ${id}: ${exception instanceof Error ? (exception.stack ?? exception.message) : 'unknown error'}`,
      );
    }

    const body = ApiErrorSchema.parse({
      error: { code, message, requestId: id, ...(details === undefined ? {} : { details }) },
    });
    res.status(status).json(body);
  }
}

/**
 * Validates the request body of a route against its contract before the handler runs (after the guards,
 * so an unauthenticated caller gets 401 and not a description of the schema). Path and query values are
 * checked too; Express exposes them read-only, so handlers read those raw until a route needs them typed.
 */
@Injectable()
export class ContractRequestInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const route = Reflect.getMetadata(ROUTE_METADATA, context.getHandler()) as RouteDef | undefined;
    const shape = route?.request;
    if (shape) {
      const req = context.switchToHttp().getRequest<Request>();
      if (shape.body) {
        req.body = shape.body.parse(req.body);
      }
      shape.params?.parse(req.params);
      shape.query?.parse(req.query);
    }
    return next.handle();
  }
}

/** Checks that every response matches the schema its contract promises. Catches drift in tests and dev. */
@Injectable()
export class ContractResponseInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Contract');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const route = Reflect.getMetadata(ROUTE_METADATA, context.getHandler()) as RouteDef | undefined;
    return next.handle().pipe(
      tap((body) => {
        if (!route) {
          return;
        }
        const res = context.switchToHttp().getResponse<Response>();
        const def = route.responses[res.statusCode];
        if (!def) {
          this.logger.error(
            `${route.operationId} answered ${String(res.statusCode)}, which its contract does not list`,
          );
          throw new Error('contract violation');
        }
        if (def.binary) {
          // A file is streamed as it is; there is no JSON to check.
          if (!(body instanceof StreamableFile)) {
            this.logger.error(`${route.operationId} is a download but did not answer with a file`);
            throw new Error('contract violation');
          }
          return;
        }
        const result = def.schema.safeParse(body);
        if (!result.success) {
          this.logger.error(
            `${route.operationId} broke its contract: ${result.error.issues.map((i) => i.message).join('; ')}`,
          );
          throw new Error('contract violation');
        }
      }),
    );
  }
}
