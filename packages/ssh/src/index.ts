// @swellwright/ssh: the SSH layer. A pure library: no database, no HTTP, no UI.
//
//   fetchHostKey         read a server's host key without sending credentials (first-use confirmation)
//   SshConnection        one authenticated connection: exec, sftp
//   SshPool              reuse and cap connections
//   startDetachedStep... work that survives the connection and can be followed again
//   validateTargetAddress  refuse loopback, link-local and metadata addresses before connecting
//
// See README.md and docs/adr/0035-ssh-layer.md.

export {
  HostKeyMismatchError,
  SshAbortError,
  SshAuthError,
  SshConnectError,
  SshConnectionLostError,
  SshError,
  SshExecError,
  SshHashMismatchError,
  SshInputError,
  SshPoolClosedError,
  SshSftpError,
  SshStepError,
  SshTimeoutError,
  redact,
} from './errors.js';
export type { SshConnectReason, SshErrorCode, SshTimeoutPhase } from './errors.js';

export {
  assertTargetAddress,
  classifyAddress,
  resolveTargetAddress,
  validateTargetAddress,
} from './address.js';
export type {
  AddressKind,
  ResolvedTarget,
  TargetAddressCheck,
  TargetAddressPolicy,
} from './address.js';

export { SshConnection } from './connection.js';
export type { SshConnectionEvents } from './connection.js';

export { fetchHostKey, fingerprintOf, hostKeyAlgorithmsPreferring } from './host-key.js';
export type { FetchHostKeyOptions } from './host-key.js';

export { SftpClient } from './sftp.js';
export type {
  SftpGetOptions,
  SftpPutOptions,
  SftpStat,
  SftpTransferResult,
  SftpVerify,
} from './sftp.js';

export { SshPool } from './pool.js';
export type { SshPoolOptions, SshPoolStats } from './pool.js';

export {
  cancelStep,
  getStepStatus,
  readStepOutput,
  removeStep,
  removeStepSecrets,
  startDetachedStep,
  waitForStep,
} from './steps.js';
export type {
  CancelStepOptions,
  ReadStepOutputOptions,
  ReadStepOutputResult,
  RemoveStepOptions,
  RemoveStepSecretsOptions,
  WaitForStepOptions,
} from './steps.js';

export { defaultStepBaseDir, shellQuote } from './shell.js';

export type {
  DetachedStepSpec,
  ExecOptions,
  ExecRawResult,
  ExecResult,
  HostKeyPolicy,
  ServerHostKey,
  StepOutputChunk,
  StepState,
  StepStatus,
  StepStream,
  SshAlgorithms,
  SshAuth,
  SshTarget,
  SudoOptions,
} from './types.js';
