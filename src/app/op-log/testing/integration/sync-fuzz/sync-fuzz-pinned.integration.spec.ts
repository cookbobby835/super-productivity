import { FuzzStep } from './sync-fuzz-actions';
import { SyncFuzzHarness } from './sync-fuzz-harness';
import pinnedTraces from './sync-fuzz-pinned-traces.json';
import { FuzzFailure, runFuzz } from './sync-fuzz-runner';

/**
 * Pinned sync fuzz traces: minimized three-device traces. Each pin asserts
 * TODAY's outcome (the oracle failures of sync-fuzz-runner.ts and the
 * server's rejections), like
 * unsupported-multi-entity-conflict.integration.spec.ts pins its stops.
 * - A pin with failures reproduces a known bug on master; `ref` names its
 *   issue, or the decision that keeps it.
 * - A pin without failures is a regression test for a fixed bug; `ref` names
 *   the fixing PR.
 *
 * A fix changes the outcome and fails its pin. Then set the pin's
 * `failures`/`rejections` to the fixed outcome (usually no failures), and
 * `ref` to the fixing PR, so the trace stays as a regression test. The
 * failure message prints the new outcome. New traces come from
 * sync-fuzz-seeds.benchmark.ts.
 */

interface PinnedTrace {
  /** Failure class, shared by the traces of one bug. */
  class: string;
  /** The issue, the kept-by-design decision, or the fixing PR. */
  ref: string;
  name: string;
  steps: FuzzStep[];
  failures: FuzzFailure[];
  rejections: string[];
}

const PINS = pinnedTraces as unknown as PinnedTrace[];

describe('sync fuzz pinned traces (known current behavior)', () => {
  afterEach(() => SyncFuzzHarness.dispose());

  for (const pin of PINS) {
    it(`${pin.class}: ${pin.name}`, async () => {
      const { failures, rejections } = await runFuzz({ steps: pin.steps });
      expect({ failures, rejections })
        .withContext(
          `${pin.ref}; outcome now: ${JSON.stringify({ failures, rejections })}`,
        )
        .toEqual({ failures: pin.failures, rejections: pin.rejections });
    }, 60_000);
  }
});
