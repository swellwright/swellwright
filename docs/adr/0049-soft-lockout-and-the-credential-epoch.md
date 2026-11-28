# ADR 0049: A soft lockout, a separate second-factor lock and the credential epoch

Status: accepted

Policy: **default, revisable**. This changes the lockout of ADR 0014 and ADR 0017 and the session handling of
ADR 0014, 0016 and 0022.

## Context

ADR 0014 gave the password and the second factor one failure count per account: five in a row locked the account for
15 minutes and ended all its sessions. ADR 0017 reused the count for step-up. The review of 2026-11-25 found three
problems with it:

- **Anyone could lock anyone out.** Only a login name was needed: five wrong passwords every quarter hour kept an
  account, owners included, signed out and unable to sign in. That is a denial of service available to every visitor.
- **The count was not atomic.** The lock was checked before a code was evaluated and the failure written afterwards, in
  separate statements. Many requests at once all passed the check, so far more codes were tried than the limit allowed;
  a success in flight could clear a lock set by a concurrent failure; the lock and the end of the sessions were separate
  writes.
- **A proof could outlive the credentials it was made for.** A sign-in that had verified the old password could insert
  a session after a reset had deleted the credential and the sessions; a second step could complete after its pending
  session was revoked; an invitation could be accepted while a reset replaced it; two enrollment starts could hand out
  two secrets. Every check and the write that depended on it were separate statements.

## Decision

- **Wrong passwords slow new sign-ins down and never end a session.** Each source (an IPv4 address in any spelling, or
  an IPv6 `/64`, which one host usually holds whole) gets five wrong passwords per account in a fixed 15-minute window
  that starts with its first failure; then that source waits until the window ends. All sources together get twenty;
  from the twentieth on, every admitted wrong password makes the account wait 1, 2, 4 and at most 8 seconds before the
  next password is checked (never past the end of the window, and the count stops at 23). A request that arrives during
  a wait answers 429 with `Retry-After` whatever the password, counts nothing and moves no deadline. Established sessions
  and their elevation are untouched, so an owner who is signed in keeps working, and can step up, while someone guesses.
  An account keeps at most 64 live per-source rows; a further source counts only towards the account-wide limit.
  A source MFA lock also refuses either password with the same `429` and does not count a password failure.
- **Password-only sessions have two second-factor budgets.** A pending cookie works only in the IPv4 address or IPv6
  `/64` where it was issued. Sign-in and enrollment confirmation share a fixed 15-minute failure window per account
  and source. At `SW_LOCKOUT_ATTEMPTS` (default 5), the pair locks for `SW_LOCKOUT_MINUTES` (default 15) and its pending
  sessions end in the same transaction. Across all sources, twice that many failures pause pending factor verification
  until the account's fixed 15-minute window ends. Neither switching addresses nor a successful proof resets the
  account-wide window. Successful proofs clear only their own source counter. Only a failed proof needs a source row:
  at 64 rows it may evict the oldest unlocked row, never a live lock. If every slot is locked, the account counter
  still applies. Reaching the row cap alone never refuses a proof.
- **Step-up has a separate budget for an already authenticated session.** Failed proofs in one active session are
  counted durably in its own 15-minute window. At the configured threshold, that session ends unless it is currently
  elevated. A currently elevated session keeps its existing deadline, but re-elevation waits out the lock. A
  password-only attacker cannot spend this budget; a failure in another active session cannot spend it either. Once
  authentication resolves the session, step-up also limits requests per session and address; denied requests use a
  separate address budget. When the valid-session address map is full, untracked keys fall back to durable session
  counters rather than losing access to step-up. A stolen copy of the same active cookie shares that session's budget.
- **A credential epoch on the user.** `users.credential_epoch` counts the changes after which no earlier proof may be
  used: a credential reset, disabling, a password change, an accepted invitation, ending every session of an account
  (also when there is no row to delete). A source lock does not move the epoch; it checks its own state before any
  factor claim and deletes only the affected rows. Every session stores the epoch it was issued under and
  is accepted only while it equals its user's. The epoch is on the user because a reset deletes the credential. When an
  operation keeps the caller's session (a password change, "end my other sessions"), it moves that session to the new
  epoch explicitly.
- **One lock per account orders everything that changes authentication state.** Sign-in, the second step, step-up,
  enrollment, invitation acceptance, setup, session revocation, logout, token issuance and revocation, reset, disabling
  and deletion take `pg_advisory_xact_lock(7761240, hashtext(user_id))` (after the users lock where that one is used,
  before the audit chain's lock), then re-read what they depend on. Time-based writes use one sample of the database
  clock after locking. Cross-account revocations lock both accounts in database lock-key order and recheck the caller's
  session epoch, permission and elevation where required, before changing the target.
  Password hashing stays outside the lock: the transaction checks that the user, the epoch and the stored hash are still
  those of the snapshot it hashed against, and otherwise answers 401 and writes nothing. A code is checked and claimed
  (its time step, or the recovery code) in the transaction that issues or elevates the session, together with the
  strict audit records; a failing record rolls the claim back. An enrollment proposal is written once and returned to
  every later start until it is confirmed.
- **Admission is bounded.** Before the session lookup a guard counts requests per source: sign-in 30 per 5 minutes,
  setup and invitation acceptance 10 per 15 minutes each, the second step and enrollment confirmation 30 per 5 minutes
  together, enrollment start and password change 30 per 5 minutes each. Step-up uses its own 30 per 5 minutes after
  resolving the session. The pre-lookup address maps hold at most 4,096 windows each and evict the oldest window
  when full, instead of denying a new address. Only setup and invitation acceptance have a shared process ceiling
  across sources (800 requests per 10 seconds each). Sign-in and session routes do not share a global ingress
  budget that anonymous requests could spend. Address eviction can reset a local source counter, but cannot reset
  the account counters in PostgreSQL or add Argon2 workers.
- **The password hasher reserves capacity.** Four hashes and at most sixteen waiters (two seconds maximum);
  dummy work cannot use the slots reserved for known accounts or authenticated sessions. The queue serves sessions,
  then known accounts, then dummy work, FIFO within each class, and reserves queue space for higher priority work.
  With a one-slot test configuration the active hash cannot be interrupted, so priority applies to the queue.
  At most twenty valid login requests per source per five minutes reach account lookup. This budget is charged
  before lookup, regardless of whether the username exists or would use a dummy hash.
  A refusal due to the hasher answers 429 with `Retry-After: 2`. Setup and invitation passwords use the known-account
  lane only after proof of the setup or invitation token.
- **Authentication audit sampling isolates traffic.** Per process and minute, up to 20 unverified attempts, 30
  known-account failures and 10 setup refusals are sampled, with narrower source and account limits. Each minute,
  `auth.failures.summarized` reports suppressed counts by class without including inputs or identifiers. The first
  account-wide password slowdown in a window emits `auth.password.throttled`; this and lock transitions bypass the
  samples. Failure records are best effort and do not gate the security state changes.
- **Compose requires an explicit proxy choice.** ADR 0031 sidecars reach the same core port as the console over
  their plugin network. Trusting all private peers lets them influence source limits; defaulting to `false` behind a
  proxy instead collapses all clients onto that proxy's source budget. Configure the observed reverse-proxy address
  or exclusive proxy CIDR, and have it overwrite `X-Forwarded-For`. Use explicit `false` for direct access only.
  If a private peer sends an ignored forwarded header, the API warns once per process without trusting or logging
  the values. With trust disabled, forwarded addresses cannot split the peer's five-failure password budget.
- **A wrong current password in a password change** is limited to five per 15 minutes per session and never counts
  towards the sign-in limits. A process admits one concurrent password change per session before it starts hashing.

## Consequences

- A reset, a disable or a bulk revocation that commits first makes any older proof useless; if the sign-in commits
  first, the later operation sees its session and ends it. The guarantee is about new authentication state and the
  next request of a session; a request already authorized elsewhere in the API may still finish after a revocation.
- The migration (`20261126010000_fence_authentication`) deletes every browser session, pending ones included, so every
  person signs in again once. Password hashes, enrolled and proposed authenticators, used recovery codes, invitations and
  API tokens are kept. The old combined failure count is dropped. Stop the old API and the host command before applying
  it, and do not run an older build against the migrated schema. The migration locks the session table by adding the
  nullable columns before deleting legacy rows, then sets both columns `NOT NULL` in the same transaction (F10).
- Every authentication writer must take the account lock; a review of a new writer has to check that. Two accounts
  whose ids hash alike only wait for each other.

## Trade-offs

- **A soft lockout, not a hard one.** Someone guessing from many addresses can still keep an account's new sign-ins
  waiting up to eight seconds between checks for as long as they keep guessing, and people behind one address share its
  budget. In exchange, nobody can sign an owner out or keep them out with a login name alone, and an owner who is signed
  in is not affected at all. A hard lock after wrong passwords was rejected for that reason.
- **The wait reveals that a name is known.** A 429 after wrong passwords tells the guesser that the account exists, as
  the lock of ADR 0014 did. Unknown accounts are not counted.
- **The aggregate limit can delay fresh sign-ins.** Someone with the correct password can spend the pending-factor
  budget for that account, but cannot end active sessions or delay their step-up by exhausting that budget. In a
  password-only session, changing networks between the two steps requires signing in again. Limits do not prevent
  shared resource exhaustion outside the factor verifier, such as saturation of the database or reverse proxy.
- **The address budgets live in one process** and start over at a restart; the account counters are in PostgreSQL and
  survive it. Shared budgets across several API processes, device-bound cookies, WebAuthn and recovery by e-mail are
  not built here.

### Follow-ups / not done

- **F4 — Distributed password guesses over many windows.** The eight-second cooldown is not a daily cap. A sustained
  distributed attempt can still make roughly 12,000 checks per day. Follow up with escalation across windows, a daily
  budget and operator notification, without turning a username alone into a means of locking the owner out.
- **F7 — Username disclosure via throttling (accepted trade-off).** A 429 can reveal a known account under pressure.
  The code does not disambiguate which password was correct during a source MFA lock. Making all absent usernames
  hold durable account state would reopen an unbounded-memory or storage problem.
- **F8 — Follow-up pending the exact finding.** The review handoff did not include a separate description for F8;
  do not treat it as verified or closed.
- **F9 — Daily MFA ceiling.** Only the fixed 15-minute pending-factor budget is implemented. A longer account-level
  budget needs a recovery policy and must not make the active-session step-up lane vulnerable to a sign-in flood.
- **F11 — Authorization follow-up.** Ending one's other sessions does not currently require step-up.
  User mutations do not recheck the actor's epoch inside their transaction. Assess both with the recovery and console
  flows before changing them. The proxy warning above is implemented as a diagnostic, not as evidence of a proxy.
- **N3 — Hasher timing.** Dummy, known-account and authenticated requests use different lanes. Even though the
  source admission budget is shared, queue delay and overload can differ across lanes. The API does not promise
  equal response timing under load; merging lanes would undo isolation for authenticated work.

## Testing

Unit tests cover the arithmetic of both counts, the address buckets, the bounded limiter and the hasher queue. Tests
against PostgreSQL cover the source and account limits, the 64-row bound, an owner working through a password wait,
the pending-factor ceiling, isolated step-up, a burst of wrong codes and both orderings with a valid code, the epoch after every operation that moves it,
enrollment and confirmation at the same moment, an invitation a reset replaced, and the per-source guard. Tests that
need two connections at once hold the account lock from a connection of their own and race a sign-in, a second step, a
burst of codes and an invitation against a change that commits first; they run in the PostgreSQL job of the CI and are
skipped on a single-connection stand.
