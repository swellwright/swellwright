// Test doubles for code that uses @swellwright/ssh: an in-process SSH server and a stand-in for sudo.
// Not for production use.

export { generateTestKeyPair, generateTestRsaKeyPair, publicKeyFingerprint } from './keys.js';
export type { TestKeyPair } from './keys.js';
export { installFakeSudo } from './fake-sudo.js';
export { startCuttableProxy } from './proxy.js';
export type { CuttableProxy } from './proxy.js';
export type { FakeSudo } from './fake-sudo.js';
export { TestSshServer, shExecHandler, startSilentServer, startStallingServer } from './server.js';
export type {
  AuthAttempt,
  ExecHandler,
  ExecRequest,
  LoggedExec,
  TestServerOptions,
  TestUser,
} from './server.js';
