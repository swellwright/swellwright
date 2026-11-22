import {
  type BaselineDocument,
  type ObservationParamValue,
  observationKind,
  observationParamIssues,
  withParamDefaults,
} from '@swellwright/contracts';

/** One observation the script will make. Checks that ask for the same kind with the same parameters share one. */
export interface PlannedObservation {
  /** 1-based; the script prints it back with the result. */
  readonly index: number;
  readonly kind: string;
  /** Every parameter with its default filled in. */
  readonly params: Readonly<Record<string, ObservationParamValue>>;
}

export interface Plan {
  readonly observations: readonly PlannedObservation[];
  /** For each check of the document, the index of its observation. */
  readonly observationOf: readonly number[];
  /** What goes to the standard input of the script. */
  readonly text: string;
}

/** A character that would end a field or a line of the plan, or that is not text at all. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
const UNSAFE = /[\u0000-\u001f\u007f]/u;

function planValue(value: ObservationParamValue): string {
  const text = String(value);
  if (UNSAFE.test(text)) {
    throw new Error(
      'A parameter value holds a control character; the catalogue patterns forbid it.',
    );
  }
  return text;
}

/**
 * Turns a validated document into the plan the script reads. The parameters were checked when the document was
 * validated, and they are checked again here, because this is the last place before they leave for a server.
 */
export function buildPlan(document: BaselineDocument): Plan {
  const observations: PlannedObservation[] = [];
  const byKey = new Map<string, number>();
  const observationOf: number[] = [];
  for (const check of document.checks) {
    const def = observationKind(check.observe.kind);
    if (!def) {
      throw new Error(`Unknown observation kind "${check.observe.kind}".`);
    }
    const given = check.observe.params ?? {};
    const issues = observationParamIssues(def, given);
    if (issues.length > 0) {
      throw new Error(`Parameters of "${def.kind}" are not acceptable: ${issues.join(' ')}`);
    }
    const params = withParamDefaults(def, given);
    const key = `${def.kind}\u0000${JSON.stringify(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)))}`;
    let index = byKey.get(key);
    if (index === undefined) {
      index = observations.length + 1;
      byKey.set(key, index);
      observations.push({ index, kind: def.kind, params });
    }
    observationOf.push(index);
  }
  const lines = observations.map((observation) =>
    [
      String(observation.index),
      observation.kind,
      ...Object.entries(observation.params).map(([name, value]) => `${name}=${planValue(value)}`),
    ].join('\t'),
  );
  return { observations, observationOf, text: `${lines.join('\n')}\n` };
}
