// `pnpm --filter @swellwright/remnawave run fake-panel [-- --port 8801 --token <token> --version 3.4.11 --admin-session]`
//
// Starts the fake panel on a loopback port and prints its address and its token. The data is synthetic (documentation
// names and addresses); nothing here is, or talks to, a real panel. Use it to try the connection wizard and the panel
// pages of the console: set `SW_PANEL_ALLOW_HTTP=true` and `SW_PANEL_ALLOW_LOOPBACK=true` for the API first.

import { FakePanel } from './fake-panel.js';
import { FAKE_TOKEN } from './fixtures.js';
import { applyChecksScenario } from './fixtures-checks.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const port = Number(option('port') ?? process.env['FAKE_PANEL_PORT'] ?? '8801');
const token = option('token') ?? process.env['FAKE_PANEL_TOKEN'] ?? FAKE_TOKEN;
const version = option('version');
const extraNodes = Number(option('extra-nodes') ?? '0');
const extraHosts = Number(option('extra-hosts') ?? '0');

const panel = await FakePanel.start({
  port,
  token,
  adminSession: process.argv.includes('--admin-session'),
  extraNodes,
  extraHosts,
  ...(version === undefined ? {} : { version }),
});
if (process.argv.includes('--scenario') && option('scenario') === 'checks') {
  // A fleet with things wrong in it, for the checks (hosts that drift, a shared profile, dangling inbounds).
  applyChecksScenario(panel.fixtures);
  console.log('Scenario: checks');
}
console.log(`Fake panel listening on ${panel.url}`);
console.log(`Token: ${panel.token}`);
console.log('Press Ctrl+C to stop.');

const stop = (): void => {
  void panel.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
