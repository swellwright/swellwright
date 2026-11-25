import { type EnginePorts, StepDeferredError, type VaultGate } from '@swellwright/engine';

import { VaultSealedException } from '../http.js';
import type { VaultService } from '../vault/vault.service.js';

/** The reason a run waits with while the vault cannot be read (ADR 0048). */
export const VAULT_SEALED = 'vault_sealed';

/**
 * The vault gate of the engine over the vault of the process. It asks the vault itself, so it answers for this process: the
 * key lives in one process (ADR 0018), and a run that waits here is picked up again by any process whose vault is open.
 *
 * Only the sealed answer is a wait. Any other error of the vault is a fault and is left to fail the step.
 */
export function vaultGate(vault: Pick<VaultService, 'requireOpen'>): VaultGate {
  return {
    requireOpen(): void {
      try {
        vault.requireOpen();
      } catch (error) {
        if (error instanceof VaultSealedException) {
          throw new StepDeferredError(VAULT_SEALED);
        }
        throw error;
      }
    },
    isOpen(): boolean {
      try {
        vault.requireOpen();
        return true;
      } catch (error) {
        if (error instanceof VaultSealedException) {
          return false;
        }
        throw error;
      }
    },
  };
}

/** The ports of the engine, made once for the process (`ENGINE_PORTS`) from what the API already has. */
export function enginePorts(vault: Pick<VaultService, 'requireOpen'>): EnginePorts {
  return { vault: vaultGate(vault) };
}
