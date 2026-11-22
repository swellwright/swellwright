import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { PanelClient } from './client.js';
import { PanelUnavailableError } from './errors.js';

// TLS is verified unless somebody turns it off by name (ADR 0041). The certificates are made by the openssl command
// line tool when it is there; without it these tests are skipped and say so.

interface Material {
  readonly key: string;
  readonly cert: string;
}

function selfSigned(dir: string, name: string, san: string): Material | null {
  const keyFile = join(dir, `${name}.key`);
  const certFile = join(dir, `${name}.crt`);
  const run = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '2',
      '-subj',
      `/CN=${name}`,
      '-addext',
      `subjectAltName=${san}`,
      '-keyout',
      keyFile,
      '-out',
      certFile,
    ],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) {
    return null;
  }
  return { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8') };
}

const dir = mkdtempSync(join(tmpdir(), 'sw-panel-tls-'));
const good = selfSigned(dir, 'localhost', 'DNS:localhost,IP:127.0.0.1');
const wrongName = selfSigned(dir, 'other.example.com', 'DNS:other.example.com');
const missing = good === null || wrongName === null;
writeFileSync(join(dir, 'done'), '');
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function serve(material: Material): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer({ key: material.key, cert: material.cert }, (req, res) => {
      const ok = req.headers.authorization === 'Bearer tls-test-token-0000000000000000';
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(ok ? { response: { version: '3.4.11' } } : { message: 'Unauthorized' }),
      );
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

describe(
  'TLS to a panel',
  { skip: missing ? 'the openssl command is not available' : false },
  () => {
    const running: Server[] = [];
    const ports = { primary: 0, mismatched: 0 };

    before(async () => {
      if (good && wrongName) {
        const first = await serve(good);
        const second = await serve(wrongName);
        running.push(first.server, second.server);
        ports.primary = first.port;
        ports.mismatched = second.port;
      }
    });
    after(() => {
      for (const server of running) {
        server.close();
      }
    });

    const client = (
      port: number,
      options: { trustedCa?: string; allowInsecureTls?: boolean; host?: string } = {},
    ): PanelClient =>
      new PanelClient({
        baseUrl: `https://${options.host ?? 'localhost'}:${String(port)}`,
        token: 'tls-test-token-0000000000000000',
        sleep: () => Promise.resolve(),
        ...(options.trustedCa === undefined ? {} : { trustedCa: options.trustedCa }),
        ...(options.allowInsecureTls === undefined
          ? {}
          : { allowInsecureTls: options.allowInsecureTls }),
      });

    it('refuses a certificate the system does not trust, and says so as a TLS problem', async () => {
      const c = client(ports.primary);
      try {
        await assert.rejects(
          () => c.version(),
          (error: unknown) =>
            error instanceof PanelUnavailableError &&
            error.reason === 'tls' &&
            error.message.includes('certificate'),
        );
      } finally {
        c.close();
      }
    });

    it('accepts it when its authority is configured for this panel', async () => {
      const c = client(ports.primary, { trustedCa: good?.cert ?? '' });
      try {
        assert.equal((await c.version()).version, '3.4.11');
      } finally {
        c.close();
      }
    });

    it('accepts a literal address that the certificate names', async () => {
      const c = client(ports.primary, { trustedCa: good?.cert ?? '', host: '127.0.0.1' });
      try {
        assert.equal((await c.version()).version, '3.4.11');
      } finally {
        c.close();
      }
    });

    it('still checks the name of the host against the certificate when the authority is trusted', async () => {
      const c = client(ports.mismatched, { trustedCa: wrongName?.cert ?? '' });
      try {
        await assert.rejects(
          () => c.version(),
          (error: unknown) => error instanceof PanelUnavailableError && error.reason === 'tls',
        );
      } finally {
        c.close();
      }
    });

    it('skips the verification only when it is turned off explicitly', async () => {
      const c = client(ports.mismatched, { allowInsecureTls: true });
      try {
        assert.equal((await c.version()).version, '3.4.11');
      } finally {
        c.close();
      }
      const off = client(ports.mismatched, { allowInsecureTls: false });
      try {
        await assert.rejects(() => off.version(), PanelUnavailableError);
      } finally {
        off.close();
      }
    });
  },
);
