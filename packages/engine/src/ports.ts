// What a step may reach outside the run (ADR 0048, "The fourth slice").
//
// A step never reads the database and never holds a secret: it is given ports. A port is an interface that the engine
// defines and the API implements, so the engine depends on no framework, no database client and no connection. A step is
// typed over the ports it uses (`Step<P, R, Ports>`), and the loop is given the object that has them.
//
// This slice has the port that every step needs: the vault. The ports for a server (SSH) and for the panel (reads) come with
// the adapters that implement them.

/**
 * The vault as the engine sees it. The key of the vault lives in one process and only while the vault is unsealed
 * (ADR 0018), so a run can reach a moment when the secrets it needs cannot be read. A step that needs them says so before it
 * does anything, and the run waits instead of failing.
 */
export interface VaultGate {
  /**
   * Returns when the vault can be used now. Throws `StepDeferredError('vault_sealed')` when it cannot: the step goes back to
   * waiting, the run waits with that reason, and another poll of the loop tries again after the backoff.
   *
   * Call it before the first effect of a step. A step that has already done something must not defer: the contract of
   * `StepDeferredError` is that nothing was done, because a deferred step is started again from the beginning.
   */
  requireOpen(): void;
  /**
   * Whether `requireOpen` would return now, without the deferral. The loop asks it at every poll, so that a process whose vault
   * is sealed leaves the runs that wait for a vault to a process whose vault is open (the key of the vault lives in one process).
   * It never throws.
   */
  isOpen(): boolean;
}

/** The ports of this slice. The API builds it once for the process. */
export interface EnginePorts {
  readonly vault: VaultGate;
}
