// A fake Remnawave panel for tests and for trying the console without a real panel. Not for production use.

export { FakePanel } from './fake-panel.js';
export type { Behaviour, FakePanelOptions, Match, RecordedRequest } from './fake-panel.js';
export {
  buildFixtures,
  FAKE_PANEL_VERSION,
  FAKE_SECRETS,
  FAKE_TOKEN,
  fakeUuid,
} from './fixtures.js';
export type { FixtureOptions, Json, PanelFixtures } from './fixtures.js';
export { must } from './must.js';
