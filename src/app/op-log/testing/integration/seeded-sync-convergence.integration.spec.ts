import { TestBed } from '@angular/core/testing';
import { Action, ActionReducer, provideStore, Store } from '@ngrx/store';
import { firstValueFrom } from 'rxjs';
import { SnackService } from '../../../core/snack/snack.service';
import { incrementVectorClock } from '../../../core/util/vector-clock';
import {
  addNote,
  updateNote,
  updateNoteOrder,
} from '../../../features/note/store/note.actions';
import { initialNoteState, noteReducer } from '../../../features/note/store/note.reducer';
import { projectReducer } from '../../../features/project/store/project.reducer';
import { WorkContextType } from '../../../features/work-context/work-context.model';
import { loadAllData } from '../../../root-store/meta/load-all-data.action';
import { createBaseState } from '../../../root-store/meta/task-shared-meta-reducers/test-utils';
import { lwwUpdateMetaReducer } from '../../../root-store/meta/task-shared-meta-reducers/lww-update.meta-reducer';
import { RootState } from '../../../root-store/root-state';
import { ArchiveOperationHandler } from '../../apply/archive-operation-handler.service';
import { bulkOperationsMetaReducer } from '../../apply/bulk-hydration.meta-reducer';
import { StateSnapshotService } from '../../backup/state-snapshot.service';
import { OperationCaptureService } from '../../capture/operation-capture.service';
import { OperationLogEffects } from '../../capture/operation-log.effects';
import { buildEntityRegistry, ENTITY_REGISTRY } from '../../core/entity-registry';
import { ActionType, Operation } from '../../core/operation.types';
import { PersistentAction } from '../../core/persistent-action.interface';
import { AppDataComplete } from '../../model/model-config';
import { DB_NAME } from '../../persistence/db-keys.const';
import { OperationLogCompactionService } from '../../persistence/operation-log-compaction.service';
import { OperationLogStoreService } from '../../persistence/operation-log-store.service';
import { CURRENT_SCHEMA_VERSION } from '../../persistence/schema-migration.service';
import { RemoteOpsProcessingService } from '../../sync/remote-ops-processing.service';
import { VectorClockService } from '../../sync/vector-clock.service';
import { CLIENT_ID_PROVIDER } from '../../util/client-id.provider';
import { validateOperationPayload } from '../../validation/validate-operation-payload';
import { ValidateStateService } from '../../validation/validate-state.service';

/**
 * Seeded random multi-device sync runs, notes slice.
 *
 * Every device shares ONE real sync stack — the NgRx store with the real
 * feature reducers and sync meta-reducers, the IndexedDB op log, and the real
 * remote-op pipeline (`RemoteOpsProcessingService` → conflict detection →
 * LWW resolution → applier). A device is its saved store state plus its raw
 * op-log rows; acting as a device restores both, and acting stops at a quiet
 * point, so the per-tab caches never see two devices at once. Background
 * compaction is stubbed, because it would run against whichever device is
 * restored next: every device keeps its whole log, like a client that has
 * not compacted yet. State validation is stubbed too; it only checks that
 * listed notes exist.
 *
 * The server accepts every upload in order, as a file provider does; devices
 * resolve crossings when they download. A seed picks the device, the user
 * action and the sync timing; ids, timestamps and choices all come from it,
 * so a failing seed replays exactly. After the run every device syncs until
 * nothing new arrives. Then these checks run:
 *  - `stop:<error>`: the remote pipeline threw, so sync stops for the user;
 *  - `livelock`: syncing never went quiet;
 *  - `diverge:<key>`: two devices disagree on a synced note field, or on a
 *    list's members or order;
 *  - `invariant:<name>`: one device's own state contradicts itself.
 *
 * To study one run, call `runSeed(seed, profile)` from a focused spec.
 */

/**
 * Every failure class current master still produces: where it is tracked, and
 * one run (`profile/seed`) that must keep reproducing it. The suite fails on a
 * class missing here (a new bug or a regression) and on a witness that stops
 * reproducing its class: then delete the entry in the PR that fixed it, or
 * move the witness to a run that still fails. This list may only shrink.
 */
const KNOWN_FAILURES: readonly {
  signature: string;
  tracking: string;
  witness: `${Profile['name']}/${number}`;
}[] = [
  {
    signature:
      'stop:UnsupportedMultiEntityConflictError: SYNC_MULTI_ENTITY_UNSUPPORTED ' +
      'side=local actionType=[Note] Update Note Order',
    tracking:
      '#10264 class: a note reorder crossing an edit of a listed note stops sync. ' +
      '#10364 admits in-place edits; Today order vs pin keeps the stop on purpose.',
    witness: 'all/2',
  },
  {
    signature:
      'stop:UnsupportedMultiEntityConflictError: SYNC_MULTI_ENTITY_UNSUPPORTED ' +
      'side=remote actionType=[Note] Update Note Order',
    tracking: 'as the side=local stop, with the reorder arriving from the other device',
    witness: 'all/4',
  },
  {
    signature: 'diverge:content',
    tracking:
      '#10260: a losing op leaves its other fields on this device only. Notes have ' +
      'no field-level merge, so a pin loses to a content edit and vice versa. ' +
      'Confirmed with two browsers over WebDAV (2026-09).',
    witness: 'fields/5',
  },
  {
    signature: 'diverge:isPinnedToToday',
    tracking: '#10260, as diverge:content',
    witness: 'fields/12',
  },
  {
    signature: 'diverge:todayMembers',
    tracking:
      'A whole-note LWW update changes isPinnedToToday without writing ' +
      'note.todayOrder, so a note is listed in Today on one device only. Gap noted ' +
      'in #10364; no issue. Confirmed with two browsers over WebDAV (2026-09).',
    witness: 'fields/4',
  },
  {
    signature: 'invariant:todayOrder-vs-pinned',
    tracking: 'the same whole-note LWW gap, seen on one device',
    witness: 'fields/4',
  },
  {
    signature: 'invariant:todayOrder-duplicates',
    tracking:
      'Pinning a note already in note.todayOrder adds it twice (#10364 dedups the pin).',
    witness: 'fields/16',
  },
  {
    signature: 'diverge:todayOrder',
    tracking:
      'Pins prepend in local arrival order, so devices can order Today notes ' +
      'differently (order only; no issue). Duplicates above also show here.',
    witness: 'fields/57',
  },
];
const KNOWN_SIGNATURES = new Set(KNOWN_FAILURES.map((known) => known.signature));

type TestState = RootState;

const PROJECT = 'project1';
const NOTE_IDS = ['n1', 'n2', 'n3'];
const DEVICE_IDS = ['deviceA', 'deviceB'];
const STEPS = 16;
const SEEDS = 60;
const SEEDS_PER_SPEC = 20;
const SETTLE_ROUNDS = 6;
const HANG_MS = 5_000;

/**
 * Action mixes, each run for every seed. On master a reorder crossing an edit
 * stops sync (#10264), which ends most `all` runs before later bugs can show.
 */
const PROFILES = [
  { name: 'fields', reorderShare: 0 },
  { name: 'all', reorderShare: 0.45 },
] as const;
type Profile = (typeof PROFILES)[number];

interface DbDump {
  [storeName: string]: {
    isInlineKey: boolean;
    rows: { key: IDBValidKey; value: unknown }[];
  };
}

interface Device {
  id: string;
  state: TestState;
  db: DbDump;
  /** Number of server ops this device has downloaded. */
  cursor: number;
}

interface Failure {
  signature: string;
  detail: string;
}

interface RunResult {
  seed: number;
  profile: Profile['name'];
  trace: string[];
  failures: Failure[];
}

/** mulberry32: small seeded PRNG so a failing seed replays exactly. */
const createRandom = (seed: number): (() => number) => {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const openRawDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** JSON with sorted object keys: equal values compare equal whatever the key order. */
const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : v,
  );

const txDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

const membersOf = (ids: readonly string[]): string[] => [...new Set(ids)].sort();

/** What every device must agree on once sync is quiet. */
const viewOf = (state: TestState): Record<string, string> => {
  const notes = NOTE_IDS.map((id) => state.note.entities[id]);
  const today = state.note.todayOrder;
  const project = state.projects.entities[PROJECT]?.noteIds ?? [];
  return {
    content: JSON.stringify(notes.map((note) => note?.content)),
    isPinnedToToday: JSON.stringify(notes.map((note) => note?.isPinnedToToday)),
    projectId: JSON.stringify(notes.map((note) => note?.projectId)),
    todayMembers: JSON.stringify(membersOf(today)),
    todayOrder: JSON.stringify(today),
    projectMembers: JSON.stringify(membersOf(project)),
    projectOrder: JSON.stringify(project),
  };
};

/** A list's order only counts once its members agree. */
const ORDER_KEY_MEMBERS: Readonly<Record<string, string>> = {
  todayOrder: 'todayMembers',
  projectOrder: 'projectMembers',
};

const findDivergence = (devices: Device[]): Failure[] => {
  const [first, ...rest] = devices.map((d) => ({ id: d.id, view: viewOf(d.state) }));
  const failures: Failure[] = [];
  for (const other of rest) {
    for (const key of Object.keys(first.view)) {
      const membersKey = ORDER_KEY_MEMBERS[key];
      if (membersKey && first.view[membersKey] !== other.view[membersKey]) {
        continue;
      }
      if (first.view[key] !== other.view[key]) {
        failures.push({
          signature: `diverge:${key}`,
          detail: `${first.id}=${first.view[key]} ${other.id}=${other.view[key]}`,
        });
      }
    }
  }
  return failures;
};

const findInvariantViolations = (device: Device): Failure[] => {
  const { note, projects } = device.state;
  const failures: Failure[] = [];
  const check = (name: string, isOk: boolean, detail: string): void => {
    if (!isOk) {
      failures.push({
        signature: `invariant:${name}`,
        detail: `${device.id}: ${detail}`,
      });
    }
  };
  const pinned = NOTE_IDS.filter((id) => note.entities[id]?.isPinnedToToday);
  const inProject = NOTE_IDS.filter((id) => note.entities[id]?.projectId === PROJECT);
  const projectNoteIds = projects.entities[PROJECT]?.noteIds ?? [];
  check(
    'todayOrder-duplicates',
    new Set(note.todayOrder).size === note.todayOrder.length,
    JSON.stringify(note.todayOrder),
  );
  check(
    'todayOrder-vs-pinned',
    JSON.stringify(membersOf(note.todayOrder)) === JSON.stringify(membersOf(pinned)),
    `todayOrder=${JSON.stringify(note.todayOrder)} pinned=${JSON.stringify(pinned)}`,
  );
  check(
    'projectNoteIds-vs-notes',
    JSON.stringify(membersOf(projectNoteIds)) === JSON.stringify(membersOf(inProject)),
    `noteIds=${JSON.stringify(projectNoteIds)} notes=${JSON.stringify(inProject)}`,
  );
  return failures;
};

describe('seeded multi-device sync convergence (notes)', () => {
  let store: Store<TestState>;
  let db: OperationLogStoreService;
  let remoteOps: RemoteOpsProcessingService;
  let vectorClocks: VectorClockService;
  let capture: OperationCaptureService;
  let initial: TestState;
  let currentDeviceId = DEVICE_IDS[0];

  const currentState = (): Promise<TestState> => firstValueFrom(store);

  const setState = (value: TestState): void => {
    store.dispatch(
      loadAllData({
        appDataComplete: {
          ...value,
          project: value.projects,
        } as unknown as AppDataComplete,
      }),
    );
  };

  const dumpDb = async (): Promise<DbDump> => {
    const raw = await openRawDb();
    try {
      const names = Array.from(raw.objectStoreNames);
      const tx = raw.transaction(names, 'readonly');
      const dump: DbDump = {};
      await Promise.all(
        names.map(
          (name) =>
            new Promise<void>((resolve, reject) => {
              const objectStore = tx.objectStore(name);
              const rows: { key: IDBValidKey; value: unknown }[] = [];
              const req = objectStore.openCursor();
              req.onsuccess = () => {
                const cursor = req.result;
                if (cursor) {
                  rows.push({ key: cursor.primaryKey, value: cursor.value });
                  cursor.continue();
                } else {
                  dump[name] = { isInlineKey: objectStore.keyPath !== null, rows };
                  resolve();
                }
              };
              req.onerror = () => reject(req.error);
            }),
        ),
      );
      return dump;
    } finally {
      raw.close();
    }
  };

  const restoreDb = async (dump: DbDump): Promise<void> => {
    // Clears every store AND the store service's per-tab caches.
    await db._clearAllDataForTesting();
    const names = Object.keys(dump);
    if (names.length === 0) {
      return;
    }
    const raw = await openRawDb();
    try {
      const tx = raw.transaction(names, 'readwrite');
      for (const name of names) {
        const objectStore = tx.objectStore(name);
        for (const { key, value } of dump[name].rows) {
          if (dump[name].isInlineKey) {
            objectStore.put(value);
          } else {
            objectStore.put(value, key);
          }
        }
      }
      await txDone(tx);
    } finally {
      raw.close();
    }
  };

  const enter = async (device: Device): Promise<void> => {
    currentDeviceId = device.id;
    await restoreDb(device.db);
    setState(device.state);
    // Harness self-check: the switch must restore this device exactly.
    const restored = await currentState();
    for (const slice of ['note', 'projects'] as const) {
      if (stableStringify(restored[slice]) !== stableStringify(device.state[slice])) {
        throw new Error(`HARNESS: ${slice} not restored for ${device.id}`);
      }
    }
    if (stableStringify(await dumpDb()) !== stableStringify(device.db)) {
      throw new Error(`HARNESS: op log not restored for ${device.id}`);
    }
  };

  const leave = async (device: Device): Promise<void> => {
    device.state = await currentState();
    device.db = await dumpDb();
  };

  const explore = async (
    seed: number,
    profile: Profile,
    trace: string[],
  ): Promise<RunResult> => {
    const random = createRandom(seed);
    const pick = <T>(items: readonly T[]): T =>
      items[Math.floor(random() * items.length)];
    /** Fisher–Yates: the same order in every JS engine. */
    const shuffle = <T>(items: readonly T[]): T[] => {
      const result = [...items];
      for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
      }
      return result;
    };
    let opCounter = 0;
    let clock = 1_000_000;
    const server: Operation[] = [];

    const devices: Device[] = [];
    for (const id of DEVICE_IDS) {
      await db._clearAllDataForTesting();
      devices.push({ id, state: initial, db: await dumpDb(), cursor: 0 });
    }

    const opIdBase = seed * 10_000;
    const nextOpId = (): string =>
      `00000000-0000-7000-8000-${(opIdBase + ++opCounter).toString(16).padStart(12, '0')}`;

    /** Mirrors OperationLogEffects: current clock + 1 for this client, then append. */
    const act = async (device: Device, action: PersistentAction): Promise<void> => {
      db.clearVectorClockCache();
      const vectorClock = incrementVectorClock(
        await vectorClocks.getCurrentVectorClock(),
        device.id,
      );
      const { type, meta, ...actionPayload } = action;
      const entityIds = meta.entityIds ?? (meta.entityId ? [meta.entityId] : undefined);
      const op: Operation = {
        id: nextOpId(),
        actionType: type as ActionType,
        opType: meta.opType,
        entityType: meta.entityType,
        entityId: meta.entityId ?? entityIds?.[0],
        entityIds,
        payload: { actionPayload, entityChanges: capture.extractEntityChanges(action) },
        clientId: device.id,
        vectorClock,
        timestamp: (clock += 1000),
        schemaVersion: CURRENT_SCHEMA_VERSION,
      };
      if (!validateOperationPayload(op).success) {
        throw new Error(`HARNESS: invalid payload for ${type}`);
      }
      store.dispatch(action);
      await db.appendWithVectorClockOverwrite(op, 'local');
    };

    /** Download, resolve and apply, then upload what is pending (file-provider order). */
    const sync = async (device: Device): Promise<void> => {
      const incoming = server
        .slice(device.cursor)
        .filter((op) => op.clientId !== device.id);
      if (incoming.length > 0) {
        await remoteOps.processRemoteOps(incoming);
      }
      device.cursor = server.length;
      const pending = await db.getUnsynced();
      if (pending.length > 0) {
        server.push(...pending.map((entry) => entry.op));
        await db.markSynced(pending.map((entry) => entry.seq));
        device.cursor = server.length;
      }
    };

    const localAction = async (device: Device): Promise<string> => {
      const state = await currentState();
      const noteId = pick(NOTE_IDS);
      // Edit and pin split the non-reorder share evenly.
      const roll = random();
      const fieldShare = 1 - profile.reorderShare;
      const halfReorderShare = profile.reorderShare / 2;
      const projectOrderShare = fieldShare + halfReorderShare;
      if (roll < fieldShare / 2) {
        const content = `${device.id}-${++opCounter}`;
        await act(device, updateNote({ note: { id: noteId, changes: { content } } }));
        return `edit(${noteId})`;
      }
      if (roll < fieldShare) {
        const isPinnedToToday = !state.note.entities[noteId]?.isPinnedToToday;
        await act(
          device,
          updateNote({ note: { id: noteId, changes: { isPinnedToToday } } }),
        );
        return `pin(${noteId}=${isPinnedToToday})`;
      }
      if (roll < projectOrderShare) {
        const ids = shuffle(state.projects.entities[PROJECT]?.noteIds ?? []);
        await act(
          device,
          updateNoteOrder({
            ids,
            activeContextType: WorkContextType.PROJECT,
            activeContextId: PROJECT,
          }),
        );
        return `orderProject(${ids.join(',')})`;
      }
      const ids = shuffle(state.note.todayOrder);
      if (ids.length === 0) {
        return 'orderToday(empty, skipped)';
      }
      await act(
        device,
        updateNoteOrder({
          ids,
          activeContextType: WorkContextType.TAG,
          activeContextId: 'TODAY',
        }),
      );
      return `orderToday(${ids.join(',')})`;
    };

    try {
      for (let step = 0; step < STEPS; step++) {
        const device = pick(devices);
        await enter(device);
        const label =
          random() < 0.55 ? await localAction(device) : (await sync(device), 'sync');
        trace.push(`${device.id}:${label}`);
        await leave(device);
      }
      let isQuiet = false;
      for (let round = 0; round < SETTLE_ROUNDS && !isQuiet; round++) {
        const serverLength = server.length;
        for (const device of devices) {
          await enter(device);
          await sync(device);
          await leave(device);
        }
        isQuiet =
          server.length === serverLength &&
          devices.every((device) => device.cursor === server.length);
      }
      if (!isQuiet) {
        return {
          seed,
          profile: profile.name,
          trace,
          failures: [
            { signature: 'livelock', detail: `${server.length} ops on the server` },
          ],
        };
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      const message = error instanceof Error ? error.message : String(error);
      return {
        seed,
        profile: profile.name,
        trace,
        failures: [
          // Counts vary between seeds of one class; drop them from the signature.
          {
            signature: `stop:${name}: ${message.replace(/ entityCount=\d+/, '')}`,
            detail: message,
          },
        ],
      };
    }
    return {
      seed,
      profile: profile.name,
      trace,
      failures: [...findDivergence(devices), ...devices.flatMap(findInvariantViolations)],
    };
  };

  /** A run that never finishes is a failure too: sync would hang for the user. */
  const runSeed = async (seed: number, profile: Profile): Promise<RunResult> => {
    const trace: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hang = new Promise<RunResult>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            seed,
            profile: profile.name,
            trace,
            failures: [{ signature: 'hang', detail: `no progress for ${HANG_MS}ms` }],
          }),
        HANG_MS,
      );
    });
    try {
      return await Promise.race([explore(seed, profile, trace), hang]);
    } finally {
      clearTimeout(timer);
    }
  };

  beforeEach(async () => {
    const base = { ...createBaseState(), note: initialNoteState };
    const featureReducer: ActionReducer<TestState> = (s = base, a: Action) => ({
      ...s,
      projects: projectReducer(s.projects, a),
      note: noteReducer(s.note, a),
    });
    const reducer = bulkOperationsMetaReducer(lwwUpdateMetaReducer(featureReducer));
    initial = base;
    for (const id of [...NOTE_IDS].reverse()) {
      initial = reducer(
        initial,
        addNote({
          note: {
            id,
            content: id,
            projectId: PROJECT,
            created: 100,
            modified: 100,
            isPinnedToToday: true,
          },
        }),
      );
    }

    TestBed.configureTestingModule({
      providers: [
        provideStore(
          { projects: projectReducer, note: noteReducer },
          {
            initialState: initial,
            metaReducers: [bulkOperationsMetaReducer, lwwUpdateMetaReducer],
          },
        ),
        {
          provide: OperationLogEffects,
          useValue: { processDeferredActions: () => Promise.resolve() },
        },
        {
          provide: OperationLogCompactionService,
          useValue: {
            compact: () => Promise.resolve(false),
            compactIfBloated: () => Promise.resolve(),
            emergencyCompact: () => Promise.resolve(false),
          },
        },
        {
          provide: ValidateStateService,
          useValue: { validateAndRepairCurrentState: () => Promise.resolve(true) },
        },
        {
          provide: ArchiveOperationHandler,
          useValue: { handleOperation: async () => {} },
        },
        {
          provide: SnackService,
          useValue: jasmine.createSpyObj('snack', [
            'open',
            'hasPendingPersistentAction',
            'cancelPendingPersistentAction',
          ]),
        },
        {
          provide: CLIENT_ID_PROVIDER,
          useValue: {
            loadClientId: () => Promise.resolve(currentDeviceId),
            getOrGenerateClientId: () => Promise.resolve(currentDeviceId),
            clearCache: () => {},
          },
        },
        { provide: ENTITY_REGISTRY, useValue: buildEntityRegistry() },
        {
          provide: StateSnapshotService,
          useValue: {
            getStateSnapshotForOperationLog: () => {
              let current!: TestState;
              store
                .subscribe((s) => {
                  current = s;
                })
                .unsubscribe();
              return { ...current, project: current.projects };
            },
          },
        },
      ],
    });
    store = TestBed.inject(Store);
    db = TestBed.inject(OperationLogStoreService);
    remoteOps = TestBed.inject(RemoteOpsProcessingService);
    vectorClocks = TestBed.inject(VectorClockService);
    capture = TestBed.inject(OperationCaptureService);
    await db.init();
    await db._clearAllDataForTesting();
    // Normalise once through loadAllData (it adds the default Inbox project),
    // so every device switch restores exactly what was saved.
    setState(initial);
    initial = await currentState();
  });

  afterEach(async () => {
    await db._clearAllDataForTesting();
    TestBed.resetTestingModule();
  });

  it('runs every witness', () => {
    for (const { witness } of KNOWN_FAILURES) {
      const [profileName, seed] = witness.split('/');
      expect(PROFILES.some((p) => p.name === profileName) && +seed >= 1 && +seed <= SEEDS)
        .withContext(`witness ${witness} is outside the explored runs`)
        .toBeTrue();
    }
  });

  for (const profile of PROFILES) {
    for (let from = 1; from <= SEEDS; from += SEEDS_PER_SPEC) {
      const to = Math.min(from + SEEDS_PER_SPEC - 1, SEEDS);
      it(`${profile.name} seeds ${from}-${to}: only known failures, witnesses still fail`, async () => {
        const bySignature = new Map<string, { runs: number[]; first: RunResult }>();
        for (let seed = from; seed <= to; seed++) {
          const result = await runSeed(seed, profile);
          const isHang = result.failures.some((f) => f.signature === 'hang');
          for (const signature of new Set(result.failures.map((f) => f.signature))) {
            const entry = bySignature.get(signature);
            if (entry) {
              entry.runs.push(seed);
            } else {
              bySignature.set(signature, { runs: [seed], first: result });
            }
          }
          for (const { signature, witness } of KNOWN_FAILURES) {
            if (witness === `${profile.name}/${seed}`) {
              expect(result.failures.map((f) => f.signature))
                .withContext(
                  `witness ${witness} no longer reproduces "${signature}". If a fix ` +
                    `removed it, delete its KNOWN_FAILURES entry or move the witness.`,
                )
                .toContain(signature);
            }
          }
          if (isHang) {
            // The hung run still holds the shared stack; later seeds would lie.
            break;
          }
        }
        for (const [signature, { runs, first }] of bySignature) {
          const detail = first.failures.find((f) => f.signature === signature)?.detail;
          expect(KNOWN_SIGNATURES.has(signature))
            .withContext(
              `new failure class "${signature}" in ${profile.name} seeds ${runs.join(',')}. ` +
                `Seed ${first.seed}: ${first.trace.join(' ')} => ${detail}`,
            )
            .toBeTrue();
        }
      }, 120_000);
    }
  }
});
