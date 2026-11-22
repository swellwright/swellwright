# packages/ssh

`@swellwright/ssh`: the SSH layer of Swellwright. A pure TypeScript library on `ssh2` (pure JavaScript mode, no native add-ons): no database, no HTTP, no UI. The decisions and the review of the dependency are in `docs/adr/0035-ssh-layer.md`; the design is in `docs/en/design/01-architecture.md` (section 5) and `05-security.md` (section 4).

What it gives you:

- `fetchHostKey`: read a server's host key without sending credentials (the first-use confirmation).
- `SshConnection`: one authenticated connection with a **pinned host key** (checked before any credential is sent), `exec` (stdin, streaming, output cap, deadline, `sudo` with the password only on standard input) and `sftp()`.
- `SshPool`: reuse and cap connections per host, replace dead ones, never hang.
- **Detached steps**: work that runs on the server and survives the SSH connection (`startDetachedStep`, `waitForStep`, `readStepOutput`, `getStepStatus`, `cancelStep`, `removeStep`).
- Typed errors with stable codes; no secret in any message.
- `@swellwright/ssh/test-support`: an in-process SSH server, a stand-in `sudo` and a cuttable TCP proxy, for tests of code that uses this package.

## Use

```ts
import { SshConnection, fetchHostKey, startDetachedStep, waitForStep } from '@swellwright/ssh';

// 1. First use: learn the fingerprint without sending any credential, show it, let a human confirm it.
const key = await fetchHostKey('203.0.113.10', 22);
console.log(key.algorithm, key.fingerprintSha256); // ssh-ed25519 SHA256:...

// 2. From then on connect with the key pinned. A different key fails with HostKeyMismatchError before
//    any username, password or signature leaves this machine.
const connection = await SshConnection.connect({
  host: '203.0.113.10',
  username: 'admin',
  auth: { kind: 'key', privateKey, passphrase },
  hostKey: { mode: 'pinned', fingerprints: [key.fingerprintSha256] },
});

// 3. Commands. A non-zero status is a result; errors are for what prevents a result.
const result = await connection.exec('uname -sr', { timeoutMs: 10_000 });
console.log(result.code, result.stdout);

// 4. As root: the password goes through standard input only, never in a command line or the environment.
await connection.exec('apt-get update', { sudo: { password: sudoPassword } });

// 5. Long work that must survive the connection: a detached step.
await startDetachedStep(connection, {
  id: 'upgrade-2026-11-21', // [a-z0-9-]{1,64}, chosen by you: starting it twice attaches, it does not run twice
  script: 'apt-get -y upgrade\n',
  sudo: { password: sudoPassword },
});
const status = await waitForStep(connection, 'upgrade-2026-11-21', {
  onOutput: ({ stream, data, nextOffset }) => {
    process.stdout.write(data); // keep nextOffset to resume without repeats after a reconnect
  },
});
console.log(status.state, status.exitCode); // 'exited' 0
connection.close();
```

A step survives a dropped connection. Connect again and call `waitForStep(connection, id, { fromOffsets: { stdout, stderr } })` with the offsets of the last chunk you processed; the output continues exactly where it stopped.

A step can be handed secrets (ADR 0042): `startDetachedStep(connection, { ..., secrets: { NODE_KEY: value } })` writes each value to `<step dir>/secrets/NODE_KEY` (the directory 0700, the file 0600) from the standard input of the launch, sets `NODE_KEY_FILE` for the script, and removes the directory the moment the script ends. `cancelStep`, `getStepStatus` (for a step that ended or was lost) and `removeStep` remove it as well, so a wrapper that was killed alone leaves nothing behind. The value is never in a command line, the SSH environment, `script.sh` or the `env` file. Names are `[A-Z][A-Z0-9_]{0,63}`, a value has no NUL and at most 64 KiB, at most 16 per step.

`SshPool` shares connections:

```ts
const pool = new SshPool({ maxPerHost: 2, idleMs: 30_000 });
const result = await pool.withConnection(target, (connection) => connection.exec('id -un'));
pool.closeAll();
```

## Before connecting: which addresses may be used

The inventory keeps whatever address an administrator typed, so the API asks this package before it connects (`05-security.md`, section 7). Nothing in `SshConnection.connect` or `fetchHostKey` applies the policy itself: they connect to what they are given, which is what the in-process test server needs.

```ts
import { assertTargetAddress, resolveTargetAddress, validateTargetAddress } from '@swellwright/ssh';

validateTargetAddress('169.254.169.254'); // { allowed: false, kind: 'metadata', reason: '...' }
validateTargetAddress('10.20.30.40'); //       { allowed: true, kind: 'private', ... }  (private ranges are allowed by default)
assertTargetAddress(host, { allowLoopback: false }); // throws SshInputError when refused

// A host name can resolve to anything: resolve it, check every answer, and connect to the checked address.
// Keep the pinned host key: it is what proves who answers.
const { address } = await resolveTargetAddress('node1.example.com');
await SshConnection.connect({ host: address, ...rest });
```

Refused unless the policy allows them: loopback (`127.0.0.0/8`, `::1`, `localhost`), link-local (`169.254.0.0/16`, `fe80::/10`) and the cloud metadata addresses (`169.254.169.254`, `fd00:ec2::254`, `100.100.100.200`, `metadata.google.internal`). Never allowed: unspecified, multicast and reserved addresses, and malformed or ambiguous input (a resolver reads `127.1`, `2130706433` and `0x7f.1` as loopback, so every number-only form that is not a canonical dotted quad is refused). IPv6 forms that carry an IPv4 address (`::ffff:127.0.0.1`, NAT64) are judged by the IPv4 address. Options: `allowLoopback`, `allowLinkLocal`, `allowMetadata`, `allowPrivate` (default true), `allowHostnames` (default true).

## From an inventory entry to a target

`host` is the server's address, `port` its `sshPort`, `username` and `auth` come from the access entry (the secret value from the vault: `{ kind: 'password', password }` or `{ kind: 'key', privateKey, passphrase }`), and `hostKey` is `{ mode: 'pinned', fingerprints: [pinned.fingerprintSha256] }`: the `SHA256:<base64>` form the inventory stores is exactly what `fetchHostKey` returns. The sudo password is not part of the target: it goes into the `sudo` option of the call that needs it.

## Contract notes

- **Errors**: `SshError` and its subclasses (`SshConnectError`, `SshAuthError`, `HostKeyMismatchError`, `SshTimeoutError`, `SshExecError`, `SshConnectionLostError`, `SshSftpError`, `SshHashMismatchError`, `SshStepError`, `SshInputError`, `SshAbortError`, `SshPoolClosedError`) each carry a stable `code` (`ssh_host_key_mismatch`, `ssh_timeout`, ...) and a `retryable` flag. A connection that dies rejects everything in flight with `SshConnectionLostError` and emits `close` (and `error`, when somebody listens).
- **Host keys**: `pinned` takes OpenSSH fingerprints (`SHA256:` plus unpadded base64). `discover` accepts and reports any key and is meant only for the first-use flow. A server has a host key of every type and shows the type the client prefers, so give the pinned policy the key types of the pinned keys (`keyTypes: ['ssh-rsa']`, as `fetchHostKey` names them): the connection then prefers those types and a server that gained a key of another type is not mistaken for a changed one (`hostKeyAlgorithmsPreferring(types)` builds the same list for `fetchHostKey`).
- **exec**: `env` is sent as SSH `env` requests, which a default sshd only accepts for `LANG` and `LC_*`; use a step's `env` for delivery that always works. A command that outlives its deadline may keep running on the server: use a step when it has to be stoppable.
- **SFTP**: uploads go to a temporary file, are hashed on the way, confirmed with `sha256sum` on the server (or by reading back), and renamed over the destination only when they match; a failed upload leaves no partial file.
- **Steps** need `sh`, `setsid`, `base64`, `sha256sum` and coreutils on the server (any Debian or Ubuntu) and nothing else. The default directory is `/var/lib/swellwright/steps` for root and `~/.swellwright/steps` for other users (`defaultStepBaseDir`). Layout and limits: ADR 0035.

## Tests

`pnpm --filter @swellwright/ssh run test` runs everything that can run here:

- unit and protocol tests against the in-process server (any OS; Windows skips what needs a POSIX shell);
- the step and sudo scenarios against the in-process server with a real `/bin/sh` and a stand-in `sudo` (Linux, macOS with `setsid` and `sha256sum`);
- the real-sshd tests (`*.integration.test.ts`), **skipped unless** these are set:

| Variable | Meaning |
| --- | --- |
| `SW_TEST_SSH_HOST`, `SW_TEST_SSH_PORT` | the server (port default 22) |
| `SW_TEST_SSH_USER` | the user |
| `SW_TEST_SSH_KEY` | path to that user's private key |
| `SW_TEST_SSH_SUDO_PASSWORD` | optional, the user's sudo password (enables the sudo cases) |
| `SW_TEST_SSH_BASE_DIR` | optional, a directory the user may fill and delete; its path must contain `test` (default `/tmp/swellwright-test-steps`) |

These tests never send a wrong password or key; failure paths of authentication are tested against the in-process server only. CI starts a small sshd (`packages/ssh/test/sshd/`, Ubuntu 24.04, key logins only, a throwaway key and sudo password made in the job) and runs them against it.
