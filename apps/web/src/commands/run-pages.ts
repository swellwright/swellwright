import type {
  CommandRunList,
  CommandRunListQuery,
  CommandRunState,
  CommandRunSummary,
} from '@swellwright/contracts';

/** How many runs one page asks for: the most the API gives at once. */
export const RUN_PAGE_SIZE = 200;

/**
 * The runs of every loaded page, newest first, each once. Pages are read by offset, and a run started between two
 * reads shifts the older ones by one, so a run can come in two pages.
 */
export function mergeRunPages(pages: readonly CommandRunList[]): CommandRunSummary[] {
  const seen = new Set<string>();
  const out: CommandRunSummary[] = [];
  for (const page of pages) {
    for (const run of page.runs) {
      if (!seen.has(run.id)) {
        seen.add(run.id);
        out.push(run);
      }
    }
  }
  return out;
}

/** The offset of the next (older) page, or undefined when every run is loaded. */
export function nextRunOffset(pages: readonly CommandRunList[]): number | undefined {
  const loaded = pages.reduce((sum, page) => sum + page.runs.length, 0);
  const total = pages.at(-1)?.total ?? 0;
  return loaded < total && pages.at(-1)?.runs.length !== 0 ? loaded : undefined;
}

/** The states the metric cards count. */
export const COUNTED_STATES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'partial',
] as const satisfies readonly CommandRunState[];
export type RunCounts = Readonly<Record<(typeof COUNTED_STATES)[number], number>>;

/**
 * How many runs of the whole history are in each state, not only of the loaded pages: the server's total of a list
 * filtered by state, one run long.
 */
export async function countRunsByState(
  list: (query: CommandRunListQuery) => Promise<CommandRunList>,
): Promise<RunCounts> {
  const totals = await Promise.all(
    COUNTED_STATES.map(async (state) => (await list({ state, limit: 1 })).total),
  );
  return Object.fromEntries(
    COUNTED_STATES.map((state, index) => [state, totals[index] ?? 0]),
  ) as RunCounts;
}
