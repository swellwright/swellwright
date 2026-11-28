# ADR 0017: Step-up authentication

Status: accepted

## Context
A session cookie is enough to read most of the console, and a stolen or hijacked cookie is the realistic attack on a signed-in browser. Some actions must not be possible with the cookie alone: managing users and resetting credentials today, revealing a secret, opening the terminal, creating tokens and approving risky runs later. The design (`05-security.md`) calls for step-up authentication on these; ADR 0016 listed it as the first open gap.

## Decision
- **A session can be elevated for a short time.** `sessions.elevated_until` holds the moment until which the session counts as freshly verified. The sign-in sets it (the user has just proved the authenticator, so asking again at once would only annoy), and so does the authenticator enrollment that finishes a sign-in. After that it lapses, five minutes by default (`SW_STEP_UP_MINUTES`, 1 to 30), and only a new proof renews it. A session that has never been elevated, or whose elevation ran out, is not elevated. Elevation never outlives the session.
- **The proof is the second factor, not the password.** `POST /auth/step-up` takes a code from the authenticator or a recovery code (single-use, as at sign-in). A stolen cookie has neither; a password alone would not help a thief with the cookie either, but it is the thing people reuse and phish. A code is accepted only for a time step later than the last one used, so the code that signed you in cannot be replayed to elevate; the next code comes within thirty seconds.
- **Failures count towards the lockout** exactly like a wrong code at sign-in (they share the counter), so the step-up endpoint is no way to guess codes. At the limit the account locks and its sessions end.
- **A route declares that it needs it.** `stepUp: true` in the route registry, next to `auth` and `permission`; the OpenAPI document carries it as `x-sw-step-up`. A `StepUpGuard` after the permission guard refuses a session that is not elevated with **403 and the error code `step_up_required`**, so a client can tell "ask for a code" from "not allowed" (`forbidden`). Reads never need it.
- **Permissions that always need it.** `users:write`, `vault:manage`, `vault:reveal` and `terminal:use` are listed in `STEP_UP_PERMISSIONS`; a test fails the build for a route that holds one of them and does not declare `stepUp`. A new route cannot forget it. Today that covers creating and changing users and resetting credentials; own password change declares it as well. A route with `stepUp` is for a cookie session: a bearer token (a later slice) cannot be stepped up and is refused there.
- **The session is not replaced when it is elevated.** The design asks for a new session when privileges rise; that is done at sign-in (ADR 0014), where an unauthenticated token becomes an authenticated one. Swapping the cookie on every step-up would break the requests the console has in flight at that moment, and the cookie is not what the elevation protects: the elevation is a fact about the session on the server that a stolen cookie cannot create.
- **Recorded.** `auth.step_up.succeeded` (strict, with the method) and `auth.step_up.failed` (best effort). A refusal for lack of elevation is not recorded: it is the normal prompt, not a suspicious event.
- **The console** retries the refused action after it has asked for the code once: any mutation goes through one helper that, on `step_up_required`, shows the dialog and runs the action again.

## Consequences
- A hijacked session cannot manage users, change the password or reset credentials without the authenticator, and, when later routes declare it, cannot reveal a secret or open a terminal.
- The first sensitive action after a quiet five minutes costs a code. The window is a setting; a shorter one is safer, a longer one more comfortable.
- The elevation is per session: another browser of the same user is not elevated by this one.
- Known limits: no WebAuthn yet (the proof is a TOTP or recovery code, the same factors as sign-in), no per-action prompt for a single high-risk operation (the window is shared by every action in it), and no IP or device binding of the elevation.

## Note of 2026-11-26: its own count (ADR 0049)

Changed by ADR 0049. A wrong step-up code counts only towards the active session's own limit. Failed sign-ins and enrollment confirmations do not spend that budget. Neither password failures nor a factor lock end a currently elevated session. The code claim, elevation and audit record commit together under the account lock; step-up elevation never outlives the session's idle and absolute expiry.
