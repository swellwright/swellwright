import type { PanelVersionSupport } from '@swellwright/contracts';

/**
 * The lines of the panel this release is built and tested against (ADR 0041): the frozen API description is the one of
 * 3.4.11, and every patch release of the 3.4 line is expected to keep it. A newer or older minor is reported as
 * unsupported with the reason instead of being read in the hope that it matches. When a new minor appears, it is added
 * here after the API descriptions have been compared (`oasdiff`), and the oldest line leaves the window.
 */
export const SUPPORTED_PANEL_LINES: readonly { readonly major: number; readonly minor: number }[] =
  [{ major: 3, minor: 4 }];

export const SUPPORTED_PANEL_RANGE = SUPPORTED_PANEL_LINES.map(
  (line) => `${String(line.major)}.${String(line.minor)}.x`,
).join(', ');

export interface PanelVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** For example `beta.1` in `3.4.12-beta.1`; null for a release. */
  readonly prerelease: string | null;
}

/** `3.4.11`, `v3.4.11` and `3.4.11-beta.1` are understood; anything else is not a version. */
export function parsePanelVersion(text: string): PanelVersion | null {
  const match =
    /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,40}))?(?:\+[0-9A-Za-z.-]{1,40})?$/u.exec(
      text.trim(),
    );
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/** Whether the version a panel reports is inside the window, and if not, why. */
export function assessPanelVersion(text: string | null): PanelVersionSupport {
  const range = SUPPORTED_PANEL_RANGE;
  if (text === null) {
    return { status: 'unsupported', range, reason: 'The panel did not report its version.' };
  }
  const version = parsePanelVersion(text);
  if (!version) {
    return {
      status: 'unsupported',
      range,
      reason: 'The version the panel reports is not a version number this release understands.',
    };
  }
  if (
    SUPPORTED_PANEL_LINES.some(
      (line) => line.major === version.major && line.minor === version.minor,
    )
  ) {
    return { status: 'supported', range, reason: null };
  }
  const newest = SUPPORTED_PANEL_LINES.reduce((a, b) =>
    a.major !== b.major ? (a.major > b.major ? a : b) : a.minor > b.minor ? a : b,
  );
  const newer =
    version.major > newest.major ||
    (version.major === newest.major && version.minor > newest.minor);
  const shown = `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
  return {
    status: 'unsupported',
    range,
    reason: newer
      ? `The panel runs ${shown}, which is newer than the ${range} line this release supports. Update Swellwright, or wait for support of that line.`
      : `The panel runs ${shown}, which is older than the ${range} line this release supports. Update the panel.`,
  };
}
