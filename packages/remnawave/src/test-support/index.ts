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
export { applyChecksScenario, CHECKS_ZONE } from './fixtures-checks.js';
export { must } from './must.js';
export {
  addClient,
  addProfileInbound,
  changeHostAddress,
  changeRuntimeOnly,
  changeTemplateBody,
  removeNode,
  reorderNodeTags,
  ROTATED_SECRETS,
  rotateRealityKey,
} from './snapshot-mutations.js';
