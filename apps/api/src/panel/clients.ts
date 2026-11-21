import { hkdfSync } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { validateTargetAddress } from '@swellwright/ssh';
import {
  type AddressGuard,
  PanelClient,
  parsePanelUrl,
  PanelUrlError,
} from '@swellwright/remnawave';

import { type AppConfig } from '../config.js';
import { CodedHttpException } from '../http.js';
import { CONFIG } from '../tokens.js';

export interface PanelTarget {
  readonly baseUrl: string;
  readonly trustedCa: string | null;
}

/**
 * Where clients of the panel come from (ADR 0040): configured once from the settings of this installation, so that no
 * caller can build one that skips the address policy, the TLS check or the limits. A client is made for one piece of
 * work and closed after it, so the token lives only as long as that work and is never kept in a cache.
 */
@Injectable()
export class PanelClients {
  /** Keys the fingerprint in a mask: a value that is not secret to this installation reveals nothing about a secret. */
  private readonly maskKey: Buffer;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.maskKey = Buffer.from(
      hkdfSync('sha256', config.authKey, Buffer.alloc(0), 'swellwright:panel-mask:v1', 32),
    );
  }

  /** The reason an address is refused, or null. For a name this judges the name; its answers are judged at connect time. */
  private readonly guard: AddressGuard = (address) => {
    const check = validateTargetAddress(address, {
      ...this.config.panel.policy,
      allowHostnames: false,
    });
    return check.allowed ? null : check.reason;
  };

  /**
   * Validates the address a person typed: the shape (https, no credentials), and the host against the address policy.
   * Throws a 400 for a shape that is wrong and a 409 `address_not_allowed` for a host the policy refuses.
   */
  check(input: string): string {
    let base: string;
    let hostname: string;
    try {
      const parsed = parsePanelUrl(input, { allowInsecureHttp: this.config.panel.allowHttp });
      base = parsed.base;
      hostname = parsed.hostname;
    } catch (error) {
      if (error instanceof PanelUrlError) {
        throw new CodedHttpException(400, 'bad_request', error.message);
      }
      throw error;
    }
    const verdict = validateTargetAddress(hostname, this.config.panel.policy);
    if (!verdict.allowed) {
      throw new CodedHttpException(
        409,
        'address_not_allowed',
        `${verdict.reason} Change the address of the panel, or the SW_PANEL_ALLOW_* settings of this installation.`,
        { kind: verdict.kind },
      );
    }
    return base;
  }

  create(target: PanelTarget, token: string): PanelClient {
    const { panel } = this.config;
    return new PanelClient({
      baseUrl: target.baseUrl,
      token,
      allowInsecureHttp: panel.allowHttp,
      allowInsecureTls: panel.allowInsecureTls,
      ...(target.trustedCa === null ? {} : { trustedCa: target.trustedCa }),
      timeoutMs: panel.timeoutMs,
      connectTimeoutMs: panel.connectTimeoutMs,
      maxResponseBytes: panel.maxResponseBytes,
      addressGuard: this.guard,
      maskKey: this.maskKey,
    });
  }
}
