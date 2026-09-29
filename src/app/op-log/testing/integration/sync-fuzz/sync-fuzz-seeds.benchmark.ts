import { DEFAULT_WEIGHTS, FuzzStep, IntentWeights } from './sync-fuzz-actions';
import { SyncFuzzHarness } from './sync-fuzz-harness';
import pinnedTraces from './sync-fuzz-pinned-traces.json';
import { FuzzResult, runFuzz } from './sync-fuzz-runner';
import { shrinkTrace } from './sync-fuzz-shrink';

/**
 * Random-seed entry point of the sync fuzz harness, for a nightly job or a
 * manual bug hunt. Like the other `*.benchmark.ts` files it compiles with the
 * specs but runs only when named:
 *
 *   npm run test:file src/app/op-log/testing/integration/sync-fuzz/sync-fuzz-seeds.benchmark.ts
 *
 * Each seed runs STEPS random steps of one intent mix on three devices. A
 * seed fails on a failure signature that no pinned trace shows
 * (sync-fuzz-pinned-traces.json). The first seed of each new signature is
 * shrunk by delta debugging and printed with its replay results and a dump of
 * the server log and every device's op log. Pin a trace only once it fails 3
 * of 3 replays; an intermittent failure is a harness bug first.
 *
 * FIRST_SEED moves daily; set it to a reported seed to replay that run.
 */
const FIRST_SEED = Math.floor(Date.now() / 86_400_000) * 1000;
const SEED_COUNT = 30;
const STEPS = 30;
const SHRINK_RUNS = 100;
/** Set to report every failure signature, pinned or not. */
const IGNORE_PINNED = false;

/**
 * Intent mixes. `noReorder` leaves out the reorder wedge, a stop that masks
 * every later failure on the stopped device; `tasks` concentrates on task
 * edits crossing tracked time.
 */
const PROFILES: Record<string, IntentWeights> = {
  all: DEFAULT_WEIGHTS,
  noReorder: DEFAULT_WEIGHTS.filter(
    ([kind]) => kind !== 'reorderNotes' && kind !== 'reorderHabits',
  ),
  tasks: [
    ['renameTask', 3],
    ['track', 4],
    ['doneTask', 1],
  ],
};

/** Traces to replay with a full dump, e.g. while triaging a pin. */
const DEBUG_TRACES: [string, FuzzStep[]][] = [];

const PINNED = new Set(
  (pinnedTraces as unknown as { failures: { signature: string }[] }[]).flatMap((pin) =>
    pin.failures.map((f) => f.signature),
  ),
);
const shrunk = new Set<string>();

/** The dump without device A's setup ops (clock A only, counters 1-9). */
const compactDump = (result: FuzzResult): string =>
  result.dump!.filter((line) => !/\{"fuzzDevA":[1-9]\}/.test(line)).join(' ¦ ');

const minimize = async (steps: FuzzStep[], signature: string): Promise<string> => {
  const isSame = (result: FuzzResult): boolean =>
    result.failures.some((f) => f.signature === signature);
  const minimal = await shrinkTrace(steps, isSame, SHRINK_RUNS);
  const replays: string[] = [];
  for (let replay = 0; replay < 3; replay++) {
    replays.push(isSame(await runFuzz({ steps: minimal })) ? 'fail' : 'pass');
  }
  const debug = await runFuzz({ steps: minimal, debug: true });
  return (
    `SHRUNK ${signature} replays=${replays.join(',')} trace=${JSON.stringify(minimal)} ` +
    `failures=${JSON.stringify(debug.failures)} ` +
    `rejections=${JSON.stringify(debug.rejections)} DUMP ${compactDump(debug)}`
  );
};

describe('sync fuzz random seeds', () => {
  afterEach(() => SyncFuzzHarness.dispose());

  for (const [profile, weights] of Object.entries(PROFILES)) {
    for (let seed = FIRST_SEED; seed < FIRST_SEED + SEED_COUNT; seed++) {
      it(`${profile} seed ${seed} fails only as the pinned traces do`, async () => {
        const result = await runFuzz({ seed, stepCount: STEPS, weights });
        const unknown = result.failures.filter(
          (f) => IGNORE_PINNED || !PINNED.has(f.signature),
        );
        const reports: string[] = [];
        for (const { signature } of unknown) {
          if (shrunk.has(signature)) continue;
          shrunk.add(signature);
          reports.push(await minimize(result.steps, signature));
        }
        expect(unknown)
          .withContext(
            `seed=${seed} ms=${result.ms} trace=${JSON.stringify(result.steps)} ` +
              reports.join(' ‖ '),
          )
          .toEqual([]);
      }, 900_000);
    }
  }

  for (const [name, steps] of DEBUG_TRACES) {
    it(`dumps the debug trace ${name}`, async () => {
      const result = await runFuzz({ steps, debug: true });
      fail(
        `DUMP ${name} failures=${JSON.stringify(result.failures)} ` +
          `rejections=${JSON.stringify(result.rejections)} ¦ ${compactDump(result)}`,
      );
    }, 120_000);
  }
});
