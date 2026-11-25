# ADR 0016: Users, invitations and credential reset

Status: accepted

## Context
Until now an instance had exactly one user, the owner created at first run (ADR 0014), and an owner who lost the password and the authenticator had no way back in. Roles (ADR 0015) are not useful until there are users to hold them. Three things were missing: creating users, recovering an account, and an emergency path for the case where nobody can sign in at all.

## Decision

### Users are invited, never given a password
- An owner (`users:write`) creates a user with a login name, a role and optionally a display name and an e-mail address. The user has no credential yet. The API answers with an **invitation**: a random 256-bit token, shown once, of which only the SHA-256 is stored, valid for 72 hours, one open invitation per user (a new one replaces the old).
- The invitee opens the console with the token (`#invite=<token>` in the address; the console builds the link from its own origin, so the server needs no public URL setting), chooses a password under the usual policy, and is taken to the authenticator enrollment of ADR 0014. Nobody but the invitee ever knows the password, and the token is useless afterwards: it is deleted when used.
- Handing the token over is up to the owner (a message, in person). There is no e-mail delivery yet; the link carries no secret that was not already the owner's to give.
- Accepting an invitation is limited per address, answers the same 401 for an unknown, used or expired token, and never writes the token to a log or to the audit chain.

### Reset
- **Resetting a user's credentials** (owner, or the server command below) deletes their password hash, authenticator secret, recovery codes and lockout state, ends all their sessions, and issues a new invitation. The old credentials stop working **at once**, not when the invitation is accepted: a reset is what you do when a credential may be in the wrong hands, and a window in which the old password still works would defeat it. Until the invitation is accepted the user cannot sign in.
- **Changing your own password** needs the current password and a new one under the policy. It ends your other sessions and keeps this one. A wrong current password counts towards the lockout like a wrong sign-in. The call also needs an elevated session (step-up authentication, ADR 0017), as do creating and changing users and resetting credentials.

### The server command
- `node dist/admin.js reset-credentials <login name>` (script `admin` in `apps/api`) does the reset from the host, with `SW_DATABASE_URL` and `SW_AUTH_KEY` in the environment as for the server. It prints the invitation token once to standard output. `node dist/admin.js users` lists the accounts. This is the way back for an owner who lost everything.
- It trusts whoever can run it, as the database does: someone with the database credentials can already change anything in it. It does not widen that trust, and it leaves a record: the chain gets `user.credentials.reset` with no actor and `via: cli`. It is not the remote `sw` command-line client of the design (that one talks to the API with a token).

### Rules that keep an instance reachable
- **There is always an active owner.** A change that would leave none (demoting or disabling the last one) is refused with 409. Serialized under an advisory lock, so two owners cannot remove each other at the same time.
- **Nobody changes their own role or status, or resets their own credentials, through the API.** Another owner does it, or the server command when there is no other. A mistaken click cannot lock the person at the keyboard out, and a hijacked session cannot reset the credentials of the account it sits in.
- Disabling a user ends their sessions at once. Changing a role applies on the next request (ADR 0015).
- User changes are recorded in the same transaction as the change: `user.created`, `user.updated` (what changed, old and new role and status), `user.credentials.reset`, `auth.invitation.accepted`, `auth.password.changed`.
- Users are not deleted yet. Disabling keeps their login name from being reused and their history readable; deletion is irreversible and is left for a later slice.

## Consequences
- A new instance needs only the owner's own invitation flow; adding people no longer needs database access.
- An invitation is a bearer secret for up to 72 hours. Whoever intercepts it before the invitee can set the password and enroll their own authenticator; the owner sees `invited` instead of `active` until it is used, and a reset replaces it. The authenticator step means an intercepted token still yields only an account in the invited role.
- No e-mail, no self-service "forgot password": recovery always goes through an owner or the server. That is deliberate while there is no mail channel to trust.
- Custom roles, user deletion and a session list remain for later slices.

## Note of 2026-11-26: an owner who can act
- **The owner who must remain is one who can sign in.** The rule above counts only active owners whose authenticator is confirmed (the console shows them as `active`); an owner who was invited and never finished the sign-in, or whose authenticator was never confirmed, does not keep the instance administrable. A credential reset from the console removes the authenticator, so it is refused with 409 as well when it would leave no such owner. The host command (`reset-credentials`, no actor) is not limited by the rule: it is the way back in when the last owner has lost everything. A reset, a password change and disabling also revoke the user's live API tokens (ADR 0023, note of the same date).
