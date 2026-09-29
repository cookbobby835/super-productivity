import { TestBed } from '@angular/core/testing';
import { ArchiveDbAdapter } from '../../../../core/persistence/archive-db-adapter.service';
import { Note } from '../../../../features/note/note.model';
import { Project } from '../../../../features/project/project.model';
import { SimpleCounter } from '../../../../features/simple-counter/simple-counter.model';
import { Task } from '../../../../features/tasks/task.model';
import { FULL_STATE_OP_TYPES } from '../../../core/operation.types';
import { AppStateSnapshot } from '../../../backup/state-snapshot.service';
import { OperationLogStoreService } from '../../../persistence/operation-log-store.service';
import {
  executeIntent,
  FuzzStep,
  FuzzWrite,
  fuzzDay,
  generateIntent,
  Intent,
  SETUP_INTENTS,
  viewOf,
} from './sync-fuzz-actions';
import { FuzzDevice, FuzzEventKind, SyncFuzzHarness } from './sync-fuzz-harness';

/**
 * Runs one trace (generated from a seed, or replayed from a fixture) and
 * checks the oracles. A failure's `signature` classifies it without step
 * numbers or ids, so shrinking can require "the same failure".
 */

export interface FuzzFailure {
  signature: string;
  detail: string;
}

export interface FuzzResult {
  steps: FuzzStep[];
  failures: FuzzFailure[];
  ms: number;
}

export interface FuzzOptions {
  seed?: number;
  steps?: FuzzStep[];
  stepCount?: number;
  /** Stops tolerated by the "no stops" oracle (signature prefixes). */
  knownStops?: readonly string[];
}

const DEVICES = ['A', 'B', 'C'];
const SYNC_PROBABILITY = 0.35;
const SETTLE_ROUNDS = 6;
const FAILING_EVENTS: readonly FuzzEventKind[] = [
  'stop',
  'sync-error',
  'full-state',
  'validation',
  'permanent-rejection',
  'dialog',
  'error-snack',
  'dev-error',
];

/** mulberry32, as in replacement-convergence.integration.spec.ts. */
export const createRandom = (seed: number): (() => number) => {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** What the executed intents imply, for the preservation oracles. */
class Ledger {
  readonly created = new Set<string>();
  readonly deleted = new Set<string>();
  readonly archivedEver = new Set<string>();
  readonly tracked = new Map<string, number>();
  readonly writes = new Map<string, unknown[]>();

  note(intent: Intent, writes: FuzzWrite[]): void {
    const [kind, id] = intent;
    const type = /Task$|^track$/.test(kind)
      ? 'task'
      : /Note$/.test(kind)
        ? 'note'
        : 'habit';
    const entity = `${type}:${id}`;
    if (kind.startsWith('add')) this.created.add(entity);
    if (kind.startsWith('delete')) this.deleted.add(entity);
    if (kind === 'archiveTask') this.archivedEver.add(entity);
    if (intent[0] === 'track') {
      this.tracked.set(entity, (this.tracked.get(entity) ?? 0) + intent[2]);
    }
    for (const write of writes) {
      const key = `${write.entity}|${write.field}`;
      this.writes.set(key, [...(this.writes.get(key) ?? []), write.value]);
    }
  }
}

const valueAt = (source: unknown, path: string[]): unknown =>
  path.reduce<unknown>(
    (value, key) =>
      value && typeof value === 'object'
        ? (value as Record<string, unknown>)[key]
        : undefined,
    source,
  );

/** First differing path between two JSON-like values, or undefined if equal. */
export const firstDiff = (a: unknown, b: unknown, path = ''): string | undefined => {
  if (Object.is(a, b)) return undefined;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return path;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of [...keys].sort()) {
      const diff = firstDiff(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
      if (diff !== undefined) return diff;
    }
    return undefined;
  }
  return path || '.';
};

/**
 * The synced state minus what legitimately differs per device. Reducers stamp
 * `modified` with the applying device's clock on every update (task CRUD,
 * lwwUpdateMetaReducer), so it is metadata, not content, and never converges.
 */
export const comparable = (state: unknown): unknown =>
  JSON.parse(JSON.stringify(state), (key, value) =>
    key === 'modified' ? undefined : value,
  );

const shortJson = (value: unknown): string => JSON.stringify(value)?.slice(0, 160) ?? '';

/** Strips the path of ids and indexes so it can classify a failure. */
const pathSignature = (path: string): string =>
  path
    .split('.')
    .slice(0, 4)
    .map((part) => (/^\d+$|^[tnh]\d+$|^fuzzDev/.test(part) ? '*' : part))
    .join('.');

export const runFuzz = async (options: FuzzOptions): Promise<FuzzResult> => {
  const started = performance.now();
  const harness = await SyncFuzzHarness.create();
  const failures: FuzzFailure[] = [];
  const fail = (signature: string, detail: string): void => {
    if (!failures.some((f) => f.signature === signature)) {
      failures.push({ signature, detail });
    }
  };
  const ledger = new Ledger();
  const devices = new Map<string, FuzzDevice>();
  for (const name of DEVICES) devices.set(name, await harness.addDevice(name));
  const deviceOf = (name: string): FuzzDevice => devices.get(name)!;

  // Setup: A creates the shared entities, then every device joins.
  await harness.as(deviceOf('A'), async () => {
    for (const intent of SETUP_INTENTS) {
      ledger.note(intent, (await executeIntent(harness, intent)) ?? []);
    }
  });
  for (const name of DEVICES) await harness.sync(deviceOf(name));

  const executed: FuzzStep[] = [];
  const runStep = async (step: FuzzStep, intent?: Intent): Promise<void> => {
    harness.tick();
    const device = deviceOf(step.d);
    let applied: Intent | undefined;
    if (intent) {
      await harness.as(device, async () => {
        const writes = await executeIntent(harness, intent);
        if (writes) {
          ledger.note(intent, writes);
          applied = intent;
        }
      });
    }
    if (step.s) await harness.sync(device);
    if (applied || step.s) {
      executed.push({
        d: step.d,
        ...(applied ? { a: applied } : {}),
        ...(step.s ? { s: 1 } : {}),
      });
    }
  };

  if (options.steps) {
    for (const step of options.steps) await runStep(step, step.a);
  } else {
    const random = createRandom(options.seed ?? 1);
    let idCounter = 10;
    const nextId = (prefix: string): string => `${prefix}${++idCounter}`;
    for (let i = 0; i < (options.stepCount ?? 30); i++) {
      const name = DEVICES[Math.floor(random() * DEVICES.length)];
      const intent = await harness.as(deviceOf(name), async () => {
        const archive = await TestBed.inject(ArchiveDbAdapter).loadArchiveYoung();
        return generateIntent(
          random,
          viewOf(await harness.state()),
          archive?.task.ids ?? [],
          `${name}${i}`,
          nextId,
        );
      });
      await runStep(
        { d: name, ...(random() < SYNC_PROBABILITY ? { s: 1 } : {}) },
        intent,
      );
    }
  }

  // Settle: every device syncs until a full round moves nothing.
  harness.tick();
  for (let round = 0; round < SETTLE_ROUNDS; round++) {
    const seqBefore = harness.server.latestSeq;
    let pending = 0;
    for (const name of DEVICES) {
      await harness.sync(deviceOf(name));
      pending += await harness.pendingOpCount(deviceOf(name));
    }
    if (harness.server.latestSeq === seqBefore && pending === 0) break;
  }
  const observer = await harness.addDevice('F');
  await harness.sync(observer);

  // Oracle: no stops or other sync failures (known stops excepted).
  for (const event of harness.events) {
    if (!FAILING_EVENTS.includes(event.kind)) continue;
    const signature = `${event.kind}:${event.detail
      .replace(/\b[tnh]\d+\b|fuzzDev\w|[0-9a-f-]{36}/g, '*')
      .slice(0, 120)}`;
    if (options.knownStops?.some((known) => signature.startsWith(known))) continue;
    fail(signature, `step ${event.step} ${event.device}: ${event.detail}`);
  }

  // Oracle: nothing pending, no full-state op anywhere.
  for (const name of DEVICES) {
    const device = deviceOf(name);
    const pending = await harness.pendingOpCount(device);
    if (pending > 0) fail('pending', `${name} has ${pending} unsynced op(s)`);
    const fullState = await harness.as(device, async () =>
      (await TestBed.inject(OperationLogStoreService).getOpsAfterSeq(0)).filter((e) =>
        FULL_STATE_OP_TYPES.has(e.op.opType),
      ),
    );
    for (const entry of fullState) fail(`full-state-op:${entry.op.opType}`, `${name}`);
  }

  // Oracle: convergence of every device with a fresh one.
  const reference = await harness.syncedState(observer);
  for (const name of DEVICES) {
    const state = await harness.syncedState(deviceOf(name));
    const diff = firstDiff(comparable(state), comparable(reference));
    if (diff !== undefined) {
      const path = diff.slice(1).split('.');
      fail(
        `divergence:${pathSignature(diff)}`,
        `${name} vs fresh at ${diff}: ${shortJson(valueAt(state, path))} vs ${shortJson(
          valueAt(reference, path),
        )}`,
      );
    }
  }

  checkPreservation(reference, ledger, fail);
  return { steps: executed, failures, ms: Math.round(performance.now() - started) };
};

interface EntityMap<T> {
  ids: string[];
  entities: Record<string, T | undefined>;
}

/** The slices the preservation oracles read. */
interface CheckedState {
  task: EntityMap<Task>;
  project: EntityMap<Project>;
  note: EntityMap<Note> & { todayOrder: string[] };
  simpleCounter: EntityMap<SimpleCounter>;
  archiveYoung: { task: EntityMap<Task> };
}

const checkPreservation = (
  snapshot: AppStateSnapshot,
  ledger: Ledger,
  fail: (signature: string, detail: string) => void,
): void => {
  const state = snapshot as unknown as CheckedState;
  const tasks = state.task.entities;
  const archived = state.archiveYoung.task.entities;
  const entityOf = (entity: string): Record<string, unknown> | undefined => {
    const [type, id] = entity.split(':');
    const found =
      type === 'task'
        ? (tasks[id] ?? archived[id])
        : type === 'note'
          ? state.note.entities[id]
          : state.simpleCounter.entities[id];
    return found as Record<string, unknown> | undefined;
  };

  for (const entity of ledger.created) {
    if (!ledger.deleted.has(entity) && !entityOf(entity)) {
      fail(`lost-entity:${entity.split(':')[0]}`, `${entity} was never deleted`);
    }
  }

  const day = fuzzDay();
  for (const [entity, expected] of ledger.tracked) {
    if (ledger.deleted.has(entity) || ledger.archivedEver.has(entity)) continue;
    const task = entityOf(entity) as Task | undefined;
    const actual = task?.timeSpentOnDay?.[day] ?? 0;
    if (actual !== expected) {
      fail('time-loss:task', `${entity}: tracked ${expected}, converged ${actual}`);
    }
  }

  for (const [key, values] of ledger.writes) {
    const [entity, field] = key.split('|');
    if (ledger.deleted.has(entity) || ledger.archivedEver.has(entity)) continue;
    const current = entityOf(entity);
    if (!current) continue;
    const actual = valueAt(current, field.split('.'));
    const type = entity.split(':')[0];
    const fieldName = field.split('.')[0];
    if (values.length === 1 && !Object.is(actual, values[0])) {
      fail(
        `field-reverted:${type}.${fieldName}`,
        `${entity}.${field}: only write ${shortJson(values[0])}, converged ${shortJson(actual)}`,
      );
    } else if (!values.some((v) => Object.is(v, actual))) {
      fail(
        `field-unwritten:${type}.${fieldName}`,
        `${entity}.${field}: writes ${shortJson(values)}, converged ${shortJson(actual)}`,
      );
    }
  }

  const lists: [string, unknown][] = [
    ['note.todayOrder', state.note.todayOrder],
    ['project.noteIds', state.project.entities['INBOX_PROJECT']?.noteIds],
    ['project.taskIds', state.project.entities['INBOX_PROJECT']?.taskIds],
    ['simpleCounter.ids', state.simpleCounter.ids],
  ];
  for (const [name, list] of lists) {
    if (Array.isArray(list) && new Set(list).size !== list.length) {
      fail(`duplicate:${name}`, shortJson(list));
    }
  }
};
