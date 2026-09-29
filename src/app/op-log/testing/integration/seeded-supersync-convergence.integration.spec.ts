import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { TranslateService } from '@ngx-translate/core';
import { ActionReducerMap, MetaReducer, provideStore, Store } from '@ngrx/store';
import { firstValueFrom } from 'rxjs';
import { SnackService } from '../../../core/snack/snack.service';
import { incrementVectorClock } from '../../../core/util/vector-clock';
import {
  CONFIG_FEATURE_NAME,
  globalConfigReducer,
} from '../../../features/config/store/global-config.reducer';
import {
  plannerFeatureKey,
  plannerReducer,
} from '../../../features/planner/store/planner.reducer';
import { INBOX_PROJECT } from '../../../features/project/project.const';
import {
  PROJECT_FEATURE_NAME,
  projectReducer,
} from '../../../features/project/store/project.reducer';
import {
  SECTION_FEATURE_NAME,
  sectionReducer,
} from '../../../features/section/store/section.reducer';
import { TAG_FEATURE_NAME, tagReducer } from '../../../features/tag/store/tag.reducer';
import {
  TASK_FEATURE_NAME,
  taskReducer,
} from '../../../features/tasks/store/task.reducer';
import { TaskTimeSyncService } from '../../../features/tasks/task-time-sync.service';
import { DEFAULT_TASK, Task } from '../../../features/tasks/task.model';
import {
  syncTimeSpent,
  TimeTrackingActions,
} from '../../../features/time-tracking/store/time-tracking.actions';
import {
  TIME_TRACKING_FEATURE_KEY,
  timeTrackingReducer,
} from '../../../features/time-tracking/store/time-tracking.reducer';
import { WorkContextType } from '../../../features/work-context/work-context.model';
import { UserInputWaitStateService } from '../../../imex/sync/user-input-wait-state.service';
import {
  appStateFeatureKey,
  appStateReducer,
} from '../../../root-store/app-state/app-state.reducer';
import { META_REDUCERS } from '../../../root-store/meta/meta-reducer-registry';
import { reducerFailureGuardMetaReducer } from '../../../root-store/meta/reducer-failure-guard.meta-reducer';
import { TaskSharedActions } from '../../../root-store/meta/task-shared.actions';
import { RootState } from '../../../root-store/root-state';
import { ArchiveOperationHandler } from '../../apply/archive-operation-handler.service';
import { HydrationStateService } from '../../apply/hydration-state.service';
import { OperationApplierService } from '../../apply/operation-applier.service';
import { BackupService } from '../../backup/backup.service';
import { StateSnapshotService } from '../../backup/state-snapshot.service';
import { operationCaptureMetaReducer } from '../../capture/operation-capture.meta-reducer';
import { OperationCaptureService } from '../../capture/operation-capture.service';
import { OperationLogEffects } from '../../capture/operation-log.effects';
import { buildEntityRegistry, ENTITY_REGISTRY } from '../../core/entity-registry';
import { MAX_LWW_REUPLOAD_RETRIES } from '../../core/operation-log.const';
import { ActionType, Operation } from '../../core/operation.types';
import { PersistentAction } from '../../core/persistent-action.interface';
import { OperationLogCompactionService } from '../../persistence/operation-log-compaction.service';
import { OperationLogStoreService } from '../../persistence/operation-log-store.service';
import {
  CURRENT_SCHEMA_VERSION,
  SchemaMigrationService,
} from '../../persistence/schema-migration.service';
import { SyncHydrationService } from '../../persistence/sync-hydration.service';
import { TabSeqFrontierService } from '../../persistence/tab-seq-frontier.service';
import { SyncProviderManager } from '../../sync-providers/provider-manager.service';
import { ConflictResolutionService } from '../../sync/conflict-resolution.service';
import { LockService } from '../../sync/lock.service';
import { OperationEncryptionService } from '../../sync/operation-encryption.service';
import { OperationLogDownloadService } from '../../sync/operation-log-download.service';
import { OperationLogSyncService } from '../../sync/operation-log-sync.service';
import { OperationLogUploadService } from '../../sync/operation-log-upload.service';
import { OperationWriteFlushService } from '../../sync/operation-write-flush.service';
import { RejectedOpsHandlerService } from '../../sync/rejected-ops-handler.service';
import { RemoteOpsProcessingService } from '../../sync/remote-ops-processing.service';
import { ServerMigrationService } from '../../sync/server-migration.service';
import { SupersededOperationResolverService } from '../../sync/superseded-operation-resolver.service';
import { SuperSyncStatusService } from '../../sync/super-sync-status.service';
import { SyncImportConflictCoordinatorService } from '../../sync/sync-import-conflict-coordinator.service';
import { SyncImportConflictGateService } from '../../sync/sync-import-conflict-gate.service';
import { SyncImportFilterService } from '../../sync/sync-import-filter.service';
import { SyncLocalStateService } from '../../sync/sync-local-state.service';
import { SyncSessionValidationService } from '../../sync/sync-session-validation.service';
import { countTransientRejections } from '../../sync/upload-outcome.util';
import { VectorClockService } from '../../sync/vector-clock.service';
import { CLIENT_ID_PROVIDER } from '../../util/client-id.provider';
import { RepairOperationService } from '../../validation/repair-operation.service';
import { RepairSyncContextService } from '../../validation/repair-sync-context.service';
import { validateOperationPayload } from '../../validation/validate-operation-payload';
import { ValidateStateService } from '../../validation/validate-state.service';
import {
  FakeSuperSyncProvider,
  FakeSuperSyncServer,
  useOwnOpLogDatabase,
} from './helpers/fake-super-sync.helper';

/**
 * Seeded random multi-device sync runs, tasks and tracked-time slice, against
 * an in-memory SuperSync server.
 *
 * Each device is a separate app instance: its own injector (its own sync
 * services, caches and NgRx store with the production meta-reducers) and its
 * own IndexedDB op log. A device syncs as SyncWrapperService does for
 * SuperSync: download, upload, then re-upload while conflict handling creates
 * replacement ops. The server rejects concurrent uploads per entity like the
 * real one (FakeSuperSyncServer), so rejection handling runs for real.
 * Compaction and state validation are stubbed; opening a dialog stops the run.
 *
 * Device A creates the tasks and syncs; device B joins with a first download.
 * A seed then picks the device, the edit or tracked time, and the sync timing;
 * afterwards every device syncs until nothing moves. Checks:
 *  - `stop:<reason>`: sync threw, was blocked, or reported a permanent rejection;
 *  - `livelock`: syncing never went quiet;
 *  - `diverge:<field>`: devices disagree on a synced task field;
 *  - `time:lost` / `time:extra`: a device's tracked time for the day differs
 *    from the sum of every device's tracking;
 *  - `invariant:<name>`: one device's own state or log contradicts itself.
 */

/**
 * Every failure class current master still produces: where it is tracked, and
 * one run (`profile/seed`) that must keep reproducing it. One class may list
 * several mechanisms, each with its own witness. The suite fails on a class
 * missing here and on a witness that stops reproducing its class: then delete
 * the entry in the PR that fixed it, or move the witness. This list may only
 * shrink.
 */
const KNOWN_FAILURES: readonly {
  signature: string;
  tracking: string;
  witness: `${Profile['name']}/${number}`;
}[] = [
  {
    signature: 'time:lost',
    tracking:
      '#10340: the server rejects a pending time delta that crossed an edit, and ' +
      'the re-sent task snapshot turns it into an absolute value that a later ' +
      'snapshot overwrites. Fixed by #10340.',
    witness: 'tracking/1',
  },
  {
    signature: 'time:lost',
    tracking:
      '#10257 class: a local-win task snapshot carries tracked time as an absolute ' +
      'value, and a newer concurrent edit elsewhere replaces the whole task.',
    witness: 'edits/3',
  },
  {
    signature: 'diverge:notes',
    tracking:
      'Since #10252 (in no release tag): in one download, a remote edit that ' +
      'commutes with a pending time delta is applied after this device took its ' +
      'local-win snapshot of the task, so the snapshot erases it elsewhere. No issue.',
    witness: 'tracking/35',
  },
];
const KNOWN_SIGNATURES = new Set(KNOWN_FAILURES.map((known) => known.signature));

const DEVICE_IDS = ['deviceA', 'deviceB'];
const TASK_IDS = ['t1', 't2'];
const PROJECT = INBOX_PROJECT.id;
const DAY = '2026-01-15';
const STEPS = 16;
const SEEDS = 40;
const SEEDS_PER_SPEC = 20;
const SETTLE_ROUNDS = 6;
const HANG_MS = 10_000;
const TIMESTAMP_BASE = Date.UTC(2026, 0, 15, 12);

/** Action mixes, each run for every seed. */
const PROFILES = [
  { name: 'edits', trackShare: 0.25 },
  { name: 'tracking', trackShare: 0.6 },
] as const;
type Profile = (typeof PROFILES)[number];

const HARNESS_META_REDUCERS: MetaReducer[] = META_REDUCERS.filter(
  // Capture needs the (mocked) persist effect; the guard would hide reducer throws.
  (metaReducer) =>
    metaReducer !== operationCaptureMetaReducer &&
    metaReducer !== reducerFailureGuardMetaReducer,
);

const REDUCERS = {
  [TASK_FEATURE_NAME]: taskReducer,
  [PROJECT_FEATURE_NAME]: projectReducer,
  [TAG_FEATURE_NAME]: tagReducer,
  [plannerFeatureKey]: plannerReducer,
  [appStateFeatureKey]: appStateReducer,
  [CONFIG_FEATURE_NAME]: globalConfigReducer,
  [SECTION_FEATURE_NAME]: sectionReducer,
  [TIME_TRACKING_FEATURE_KEY]: timeTrackingReducer,
} as unknown as ActionReducerMap<RootState>;

/** One instance of each per device, so no cache or session flag is shared. */
const PER_DEVICE_SERVICES = [
  OperationLogSyncService,
  OperationLogUploadService,
  OperationLogDownloadService,
  OperationEncryptionService,
  OperationLogStoreService,
  LockService,
  VectorClockService,
  SchemaMigrationService,
  RemoteOpsProcessingService,
  RejectedOpsHandlerService,
  SyncImportFilterService,
  ConflictResolutionService,
  OperationApplierService,
  SupersededOperationResolverService,
  OperationCaptureService,
  HydrationStateService,
  TabSeqFrontierService,
  SyncLocalStateService,
  SyncSessionValidationService,
  SyncImportConflictGateService,
  SyncImportConflictCoordinatorService,
  RepairSyncContextService,
  StateSnapshotService,
  OperationWriteFlushService,
  BackupService,
  TaskTimeSyncService,
];

interface Device {
  id: string;
  injector: EnvironmentInjector;
  store: Store<RootState>;
  sync: OperationLogSyncService;
  opLog: OperationLogStoreService;
  vectorClocks: VectorClockService;
  capture: OperationCaptureService;
  provider: FakeSuperSyncProvider;
  closeDb: () => Promise<void>;
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

const createDevice = async (
  id: string,
  server: FakeSuperSyncServer,
  dbName: string,
): Promise<Device> => {
  const provider = new FakeSuperSyncProvider(server);
  const injector = createEnvironmentInjector(
    [
      // Every feature starts at its reducer's initial state, as on a fresh install.
      provideStore(REDUCERS, { metaReducers: HARNESS_META_REDUCERS }),
      ...PER_DEVICE_SERVICES,
      { provide: ENTITY_REGISTRY, useValue: buildEntityRegistry() },
      {
        provide: CLIENT_ID_PROVIDER,
        useValue: {
          loadClientId: () => Promise.resolve(id),
          getOrGenerateClientId: () => Promise.resolve(id),
          clearCache: () => {},
        },
      },
      {
        provide: SyncProviderManager,
        useValue: {
          syncEpoch: 0,
          configEpoch: 0,
          isSyncInProgress: false,
          assertSyncEpochUnchanged: () => {},
          setSyncStatus: () => {},
          getActiveProvider: () => provider,
        },
      },
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
        provide: RepairOperationService,
        useValue: {
          createRepairOperation: () => {
            throw new Error('HARNESS: repair operation requested');
          },
        },
      },
      {
        provide: SyncHydrationService,
        useValue: {
          hydrateFromRemoteSync: () => {
            throw new Error('HARNESS: snapshot hydration requested');
          },
        },
      },
      {
        provide: ServerMigrationService,
        useValue: {
          checkAndHandleMigration: () => Promise.resolve(),
          handleServerMigration: () => Promise.resolve(),
        },
      },
      {
        provide: SuperSyncStatusService,
        useValue: jasmine.createSpyObj('SuperSyncStatusService', [
          'markRemoteChecked',
          'updatePendingOpsStatus',
          'clearScope',
        ]),
      },
      {
        provide: SnackService,
        useValue: jasmine.createSpyObj('SnackService', [
          'open',
          'hasPendingPersistentAction',
          'cancelPendingPersistentAction',
        ]),
      },
      {
        provide: MatDialog,
        useValue: {
          open: (component: { name?: string }) => {
            throw new Error(`HARNESS: dialog ${component?.name ?? 'unknown'} opened`);
          },
        },
      },
      { provide: UserInputWaitStateService, useValue: { startWaiting: () => () => {} } },
      { provide: TranslateService, useValue: { instant: (key: string) => key } },
    ],
    TestBed.inject(EnvironmentInjector),
    `device ${id}`,
  );
  const opLog = injector.get(OperationLogStoreService);
  const closeDb = await useOwnOpLogDatabase(opLog, dbName);
  return {
    id,
    injector,
    store: injector.get(Store) as Store<RootState>,
    sync: injector.get(OperationLogSyncService),
    opLog,
    vectorClocks: injector.get(VectorClockService),
    capture: injector.get(OperationCaptureService),
    provider,
    closeDb,
  };
};

describe('seeded multi-device SuperSync convergence (tasks and time)', () => {
  const devices: Device[] = [];

  beforeEach(() => {
    // The first download into an empty store asks the fresh-client confirm.
    if (jasmine.isSpy(window.confirm)) {
      (window.confirm as jasmine.Spy).and.returnValue(true);
    } else {
      spyOn(window, 'confirm').and.returnValue(true);
    }
  });

  afterEach(async () => {
    for (const device of devices.splice(0)) {
      device.injector.destroy();
      await device.closeDb();
    }
  });

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

  const explore = async (
    seed: number,
    profile: Profile,
    trace: string[],
  ): Promise<RunResult> => {
    const random = createRandom(seed);
    const pick = <T>(items: readonly T[]): T =>
      items[Math.floor(random() * items.length)];
    const server = new FakeSuperSyncServer();
    const trackedTotal = new Map(TASK_IDS.map((id) => [id, 0]));
    let opCounter = 0;
    let timestamp = TIMESTAMP_BASE;
    const opIdBase = seed * 10_000;
    const nextOpId = (): string =>
      `00000000-0000-7000-8000-${(opIdBase + ++opCounter).toString(16).padStart(12, '0')}`;
    const result = (failures: Failure[]): RunResult => ({
      seed,
      profile: profile.name,
      trace,
      failures,
    });
    const stateOf = (device: Device): Promise<RootState> => firstValueFrom(device.store);

    /** Mirrors OperationLogEffects: current clock + 1 for this client, then append. */
    const act = async (device: Device, action: PersistentAction): Promise<void> => {
      device.opLog.clearVectorClockCache();
      const vectorClock = incrementVectorClock(
        await device.vectorClocks.getCurrentVectorClock(),
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
        payload: {
          actionPayload,
          entityChanges: device.capture.extractEntityChanges(action),
        },
        clientId: device.id,
        vectorClock,
        timestamp: (timestamp += 1000),
        schemaVersion: CURRENT_SCHEMA_VERSION,
      };
      if (!validateOperationPayload(op).success) {
        throw new Error(`HARNESS: invalid payload for ${type}`);
      }
      device.store.dispatch(action);
      await device.opLog.appendWithVectorClockOverwrite(op, 'local');
    };

    /** SyncWrapperService's SuperSync cycle: download, upload, bounded re-upload. */
    const sync = async (device: Device): Promise<void> => {
      const isNeverSynced = !(await device.sync.hasSyncedOps());
      const download = await device.sync.downloadRemoteOps(device.provider, {
        isNeverSynced,
        keepDecryptedPrefix: true,
      });
      if (
        download.kind === 'cancelled' ||
        download.kind === 'server_migration_skipped' ||
        download.kind === 'blocked_incompatible'
      ) {
        throw new Error(`SYNC: download ${download.kind}`);
      }
      const uploads = [
        await device.sync.uploadPendingOps(device.provider, { isNeverSynced }),
      ];
      const pendingAfter = (upload: (typeof uploads)[number]): number =>
        upload.kind === 'completed'
          ? upload.localWinOpsCreated + countTransientRejections(upload)
          : 0;
      let pending =
        (download.kind === 'ops_processed' ? download.localWinOpsCreated : 0) +
        pendingAfter(uploads[0]);
      for (let retry = 0; pending > 0 && retry < MAX_LWW_REUPLOAD_RETRIES; retry++) {
        const upload = await device.sync.uploadPendingOps(device.provider, {
          isNeverSynced,
        });
        uploads.push(upload);
        pending = pendingAfter(upload);
      }
      for (const upload of uploads) {
        if (upload.kind !== 'completed') {
          throw new Error(`SYNC: upload ${upload.kind}`);
        }
        if (upload.permanentRejectionCount > 0 || upload.blockedByRejectedFullState) {
          const codes = [...new Set(upload.rejectedOps.map((op) => op.errorCode))];
          throw new Error(`SYNC: permanent rejection ${codes.sort().join(',')}`);
        }
      }
    };

    const localAction = async (device: Device): Promise<string> => {
      const state = await stateOf(device);
      const taskId = pick(TASK_IDS);
      const task = state[TASK_FEATURE_NAME].entities[taskId];
      if (!task) {
        return `missing(${taskId})`;
      }
      const roll = random();
      if (roll < profile.trackShare) {
        const duration = pick([60_000, 120_000, 300_000]);
        device.store.dispatch(
          TimeTrackingActions.addTimeSpent({
            task,
            date: DAY,
            duration,
            isFromTrackingReminder: false,
          }),
        );
        await act(device, syncTimeSpent({ taskId, date: DAY, duration }));
        trackedTotal.set(taskId, (trackedTotal.get(taskId) ?? 0) + duration);
        return `track(${taskId},${duration / 60_000}m)`;
      }
      // The rest splits evenly between title, notes and done.
      const editShare = (1 - profile.trackShare) / 3;
      const twoEditShares = 2 * editShare;
      const field =
        roll < profile.trackShare + editShare
          ? 'title'
          : roll < profile.trackShare + twoEditShares
            ? 'notes'
            : 'isDone';
      const changes: Partial<Task> =
        field === 'isDone'
          ? { isDone: !task.isDone }
          : { [field]: `${device.id}-${++opCounter}` };
      await act(device, TaskSharedActions.updateTask({ task: { id: taskId, changes } }));
      return `${field}(${taskId})`;
    };

    try {
      const deviceA = await createDevice(DEVICE_IDS[0], server, `seeded-${seed}-A`);
      devices.push(deviceA);
      for (const taskId of TASK_IDS) {
        await act(
          deviceA,
          TaskSharedActions.addTask({
            task: {
              ...DEFAULT_TASK,
              id: taskId,
              title: taskId,
              projectId: PROJECT,
              created: TIMESTAMP_BASE,
            },
            workContextId: PROJECT,
            workContextType: WorkContextType.PROJECT,
            isAddToBacklog: false,
            isAddToBottom: true,
          }),
        );
      }
      await sync(deviceA);
      const deviceB = await createDevice(DEVICE_IDS[1], server, `seeded-${seed}-B`);
      devices.push(deviceB);
      await sync(deviceB);

      for (let step = 0; step < STEPS; step++) {
        const device = pick(devices);
        const label =
          random() < 0.55 ? await localAction(device) : (await sync(device), 'sync');
        trace.push(`${device.id}:${label}`);
      }
      let isQuiet = false;
      for (let round = 0; round < SETTLE_ROUNDS && !isQuiet; round++) {
        const serverSeq = server.latestSeq;
        for (const device of devices) {
          await sync(device);
        }
        isQuiet = server.latestSeq === serverSeq;
      }
      if (!isQuiet) {
        return result([
          { signature: 'livelock', detail: `${server.latestSeq} ops on the server` },
        ]);
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      const message = error instanceof Error ? error.message : String(error);
      return result([
        {
          signature: `stop:${name}: ${message.replace(/ entityCount=\d+/, '')}`,
          detail: message,
        },
      ]);
    }

    const failures: Failure[] = [];
    const views = await Promise.all(
      devices.map(async (device) => {
        const tasks = (await stateOf(device))[TASK_FEATURE_NAME].entities;
        return {
          id: device.id,
          tasks,
          pending: (await device.opLog.getUnsynced()).length,
        };
      }),
    );
    for (const view of views) {
      if (view.pending > 0) {
        failures.push({
          signature: 'invariant:pending-after-quiet',
          detail: `${view.id}: ${view.pending} ops never uploaded`,
        });
      }
      for (const taskId of TASK_IDS) {
        const task = view.tasks[taskId];
        const tracked = task?.timeSpentOnDay?.[DAY] ?? 0;
        const expected = trackedTotal.get(taskId) ?? 0;
        if (tracked !== expected) {
          failures.push({
            signature: tracked < expected ? 'time:lost' : 'time:extra',
            detail:
              `${view.id} ${taskId}: ${tracked / 60_000}m, tracked ${expected / 60_000}m; ` +
              `server rejected [${server.rejections.join('; ')}]`,
          });
        }
        const daySum = Object.values(task?.timeSpentOnDay ?? {}).reduce(
          (sum, ms) => sum + ms,
          0,
        );
        if (task && task.timeSpent !== daySum) {
          failures.push({
            signature: 'invariant:timeSpent-vs-days',
            detail: `${view.id} ${taskId}: timeSpent ${task.timeSpent}, days ${daySum}`,
          });
        }
      }
    }
    const [first, ...rest] = views;
    for (const other of rest) {
      for (const taskId of TASK_IDS) {
        for (const field of ['title', 'notes', 'isDone', 'projectId'] as const) {
          const a = JSON.stringify(first.tasks[taskId]?.[field]);
          const b = JSON.stringify(other.tasks[taskId]?.[field]);
          if (a !== b) {
            failures.push({
              signature: `diverge:${field}`,
              detail: `${taskId} ${first.id}=${a} ${other.id}=${b}`,
            });
          }
        }
      }
    }
    return result(failures);
  };

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
          for (const device of devices.splice(0)) {
            device.injector.destroy();
            await device.closeDb();
          }
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
          if (result.failures.some((f) => f.signature === 'hang')) {
            // The hung run may still hold locks; later seeds would lie.
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
      }, 300_000);
    }
  }
});
