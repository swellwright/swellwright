// Public types of the SSH layer.

/** How the library proves who it is. A secret is held by the connection only for as long as the handshake needs it. */
export type SshAuth =
  { kind: 'password'; password: string } | { kind: 'key'; privateKey: string; passphrase?: string };

/**
 * How the server's host key is judged.
 *
 * `pinned`: the key must hash to one of the listed OpenSSH style fingerprints (`SHA256:` plus unpadded base64).
 * Anything else raises `HostKeyMismatchError` before a single credential has been sent.
 *
 * `discover`: accept whatever key is presented and report it. This exists for the first-use flow (show the
 * fingerprint, ask a human, then pin it). It must never be used for a connection that carries real credentials
 * unless the caller has already shown the fingerprint to somebody who confirmed it; `fetchHostKey` is the
 * preferred way to learn a fingerprint because it never sends credentials at all.
 */
export type HostKeyPolicy =
  | {
      mode: 'pinned';
      fingerprints: readonly string[];
      /**
       * The key types of the pinned keys, as `ServerHostKey.algorithm` names them (`ssh-ed25519`, `ssh-rsa`, ...;
       * the RSA names of the signature algorithms count as `ssh-rsa`). A server usually has a key of every type and
       * shows the type the client prefers; without this, a server that has gained a key of a more preferred type than
       * the pinned one would be taken for another machine. With it, the client prefers the pinned types in the key
       * exchange and the pinned key is the one it sees. It never excludes a type: a key that is not pinned is still
       * refused by the fingerprint check, and a type the server has no key of changes nothing.
       */
      keyTypes?: readonly string[];
    }
  | { mode: 'discover' };

/**
 * Exact lists of algorithm names offered to the server, most preferred first. Omitted categories keep the
 * defaults of ssh2 (modern ciphers, no legacy downgrade). A list is an allow-list: only the listed names are offered.
 */
export interface SshAlgorithms {
  kex?: readonly string[];
  cipher?: readonly string[];
  hmac?: readonly string[];
  serverHostKey?: readonly string[];
}

export interface SshTarget {
  host: string;
  /** Default 22. */
  port?: number;
  username: string;
  auth: SshAuth;
  hostKey: HostKeyPolicy;
  /** TCP connect, key exchange and authentication together. Default 15000. */
  connectTimeoutMs?: number;
  /** SSH-level keepalive interval; 0 turns it off. Default 10000. */
  keepaliveIntervalMs?: number;
  /** Unanswered keepalives tolerated before the connection is declared dead. Default 3. */
  keepaliveCountMax?: number;
  algorithms?: SshAlgorithms;
}

export interface ServerHostKey {
  /** The key type taken from the key blob, e.g. `ssh-ed25519`. */
  algorithm: string;
  /** `SHA256:` plus the unpadded base64 of the SHA-256 of the key blob, as `ssh-keygen -l` prints it. */
  fingerprintSha256: string;
}

export interface SudoOptions {
  /**
   * The sudo password. It travels only on the standard input of the remote wrapper, never in a command line, an
   * environment variable or a file. Leave it out when sudo needs no password (NOPASSWD) or the user is root.
   */
  password?: string;
}

export interface ExecOptions {
  /** Written to the command's standard input, which is then closed. Without it standard input is closed at once. */
  stdin?: string | Buffer;
  /**
   * Sent as SSH `env` requests. A default sshd accepts only the names in its `AcceptEnv` (usually `LANG` and
   * `LC_*`) and silently drops the rest. For delivery that always works use a detached step (`DetachedStepSpec.env`).
   */
  env?: Readonly<Record<string, string>>;
  /** Deadline for the whole command. Default 120000. The remote process may outlive it: see `cancelStep`. */
  timeoutMs?: number;
  /** Called with each decoded chunk as it arrives. A callback that throws is ignored. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Per stream cap for what is collected into the result. Default 4 MiB; callbacks still see everything. */
  maxOutputBytes?: number;
  /** Run the command as root through sudo. */
  sudo?: SudoOptions;
  signal?: AbortSignal;
}

export interface ExecResult {
  /** The exit status, or null when the command was ended by a signal or the server sent no status. */
  code: number | null;
  signal: string | null;
  /** Decoded as UTF-8; invalid sequences become U+FFFD. */
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

export interface ExecRawResult extends Omit<ExecResult, 'stdout' | 'stderr'> {
  stdout: Buffer;
  stderr: Buffer;
}

export interface DetachedStepSpec {
  /** Chosen by the caller, idempotent: `[a-z0-9-]{1,64}`. */
  id: string;
  /** POSIX `sh` text, run as `sh script.sh`. */
  script: string;
  /** The step's standard input; without it the step reads `/dev/null`. */
  stdin?: string;
  /**
   * Directory the step directories live in: an absolute path or `~/...`. Default `/var/lib/swellwright/steps` for
   * root and `~/.swellwright/steps` for any other user (also when `sudo` is used, so that polling finds it again).
   */
  baseDir?: string;
  /** Run the step as root. The password goes through standard input for the launch only. */
  sudo?: SudoOptions;
  /** Delivered through a 0600 file the wrapper sources, so it works whatever the server's `AcceptEnv` says. */
  env?: Readonly<Record<string, string>>;
}

export type StepState = 'running' | 'exited' | 'lost' | 'unknown';

export interface StepStatus {
  id: string;
  /**
   * `running`: no exit marker and the process group leader is alive. `exited`: the exit marker exists.
   * `lost`: no exit marker and the leader is gone (the server rebooted, or the process was killed outright).
   * `unknown`: the step directory exists but the wrapper has not recorded a process yet.
   */
  state: StepState;
  exitCode: number | null;
  /** ISO 8601 UTC, null until the wrapper started. */
  startedAt: string | null;
  finishedAt: string | null;
  scriptSha256: string;
  stdoutBytes: number;
  stderrBytes: number;
}

export type StepStream = 'stdout' | 'stderr';

export interface StepOutputChunk {
  stream: StepStream;
  data: Buffer;
  /** Byte offset of the first byte of `data` in the stream. */
  offset: number;
  /** The offset to resume from. */
  nextOffset: number;
}
