import { ProviderToken } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { EffectsModule } from '@ngrx/effects';
import { Action, ActionReducer, MetaReducer, Store, StoreModule } from '@ngrx/store';
import { TranslateService } from '@ngx-translate/core';
import { openDB } from 'idb';
import { IDBFactory } from 'fake-indexeddb';
import { firstValueFrom, of } from 'rxjs';
import { BannerService } from '../../../../core/banner/banner.service';
import { SnackService } from '../../../../core/snack/snack.service';
import { ClientIdService } from '../../../../core/util/client-id.service';
import { SnackParams } from '../../../../core/snack/snack.model';
import { boardsFeature } from '../../../../features/boards/store/boards.reducer';
import {
  CONFIG_FEATURE_NAME,
  globalConfigReducer,
} from '../../../../features/config/store/global-config.reducer';
import { issueProvidersFeature } from '../../../../features/issue/store/issue-provider.reducer';
import {
  menuTreeFeatureKey,
  menuTreeReducer,
} from '../../../../features/menu-tree/store/menu-tree.reducer';
import {
  METRIC_FEATURE_NAME,
  metricReducer,
} from '../../../../features/metric/store/metric.reducer';
import {
  NOTE_FEATURE_NAME,
  noteReducer,
} from '../../../../features/note/store/note.reducer';
import { plannerFeature } from '../../../../features/planner/store/planner.reducer';
import {
  PROJECT_FEATURE_NAME,
  projectReducer,
} from '../../../../features/project/store/project.reducer';
import {
  REMINDER_FEATURE_NAME,
  reminderReducer,
} from '../../../../features/reminder/store/reminder.reducer';
import {
  SECTION_FEATURE_NAME,
  sectionReducer,
} from '../../../../features/section/store/section.reducer';
import {
  SIMPLE_COUNTER_FEATURE_NAME,
  simpleCounterReducer,
} from '../../../../features/simple-counter/store/simple-counter.reducer';
import { TAG_FEATURE_NAME, tagReducer } from '../../../../features/tag/store/tag.reducer';
import {
  TASK_REPEAT_CFG_FEATURE_NAME,
  taskRepeatCfgReducer,
} from '../../../../features/task-repeat-cfg/store/task-repeat-cfg.reducer';
import {
  TASK_FEATURE_NAME,
  taskReducer,
} from '../../../../features/tasks/store/task.reducer';
import { timeTrackingFeature } from '../../../../features/time-tracking/store/time-tracking.reducer';
import { WORK_CONTEXT_FEATURE_NAME } from '../../../../features/work-context/store/work-context.selectors';
import { workContextReducer } from '../../../../features/work-context/store/work-context.reducer';
import {
  PLUGIN_METADATA_FEATURE_NAME,
  pluginMetadataReducer,
} from '../../../../plugins/store/plugin-metadata.reducer';
import {
  PLUGIN_USER_DATA_FEATURE_NAME,
  pluginUserDataReducer,
} from '../../../../plugins/store/plugin-user-data.reducer';
import { appStateFeature } from '../../../../root-store/app-state/app-state.reducer';
import { META_REDUCERS } from '../../../../root-store/meta/meta-reducer-registry';
import { ArchiveOperationHandlerEffects } from '../../../apply/archive-operation-handler.effects';
import { ArchiveOperationHandler } from '../../../apply/archive-operation-handler.service';
import { HydrationStateService } from '../../../apply/hydration-state.service';
import {
  AppStateSnapshot,
  StateSnapshotService,
} from '../../../backup/state-snapshot.service';
import {
  clearDeferredActions,
  getDeferredActions,
  setOperationCaptureService,
} from '../../../capture/operation-capture.meta-reducer';
import { OperationCaptureService } from '../../../capture/operation-capture.service';
import { OperationLogEffects } from '../../../capture/operation-log.effects';
import { UnsupportedMultiEntityConflictError } from '../../../core/errors/sync-errors';
import { MAX_LWW_REUPLOAD_RETRIES } from '../../../core/operation-log.const';
import { PersistentAction } from '../../../core/persistent-action.interface';
import { DB_VERSION } from '../../../persistence/db-keys.const';
import { runDbUpgrade } from '../../../persistence/db-upgrade';
import { IndexedDbOpLogAdapter } from '../../../persistence/indexed-db-op-log-adapter';
import { OpLogDbAdapter } from '../../../persistence/op-log-db-adapter';
import { OP_LOG_DB_ADAPTER_FACTORY } from '../../../persistence/op-log-db-adapter.token';
import { OperationLogCompactionService } from '../../../persistence/operation-log-compaction.service';
import { OperationLogStoreService } from '../../../persistence/operation-log-store.service';
import { TabSeqFrontierService } from '../../../persistence/tab-seq-frontier.service';
import { ImmediateUploadService } from '../../../sync/immediate-upload.service';
import { OperationLogDownloadService } from '../../../sync/operation-log-download.service';
import { OperationLogSyncService } from '../../../sync/operation-log-sync.service';
import { OperationWriteFlushService } from '../../../sync/operation-write-flush.service';
import { RejectedOpsHandlerService } from '../../../sync/rejected-ops-handler.service';
import { SyncSessionValidationService } from '../../../sync/sync-session-validation.service';
import { countTransientRejections } from '../../../sync/upload-outcome.util';
import { SyncProviderManager } from '../../../sync-providers/provider-manager.service';
import { CLIENT_ID_PROVIDER } from '../../../util/client-id.provider';
import {
  FakeSuperSyncClient,
  FakeSuperSyncServer,
  FuzzUnsupportedTransportError,
} from './fake-super-sync-server';

/**
 * Multi-device SuperSync harness on ONE Angular injector and ONE NgRx store.
 *
 * Real: the root store with every synced feature reducer and the registered
 * META_REDUCERS, op capture (OperationLogEffects), OperationLogStoreService,
 * the download/upload/conflict/superseded/rejected-ops services and the
 * applier. Faked: the SuperSync transport (FakeSuperSyncServer), UI
 * (snacks, dialogs, translations) and the client-id source.
 *
 * Device isolation is per-device state swapping. `as(device, fn)` swaps in,
 * before `fn`, and back out after it:
 * - the NgRx state (FUZZ_SET_STATE, handled by the outermost meta-reducer);
 * - the op-log database: every OP_LOG_DB_ADAPTER_FACTORY adapter routes to the
 *   device's own IndexedDB (ops, vector clock, state cache, archives);
 * - the client id and the device's SuperSync client (its cursor);
 * - the in-memory service state listed in DEVICE_FIELDS.
 * Anything else a service keeps in memory is shared: extend DEVICE_FIELDS
 * when the harness grows into it.
 */

const FUZZ_SET_STATE = '[SyncFuzz] Set device state';
interface SetStateAction extends Action {
  state: object;
}

const deviceStateMetaReducer: MetaReducer =
  (reducer: ActionReducer<unknown>) =>
  (state: unknown, action: Action): unknown =>
    action.type === FUZZ_SET_STATE
      ? (action as SetStateAction).state
      : reducer(state, action);

/**
 * Per-device in-memory service state. Each entry is checked on start-up, so a
 * rename in production code fails the harness instead of leaking state.
 */
const DEVICE_FIELDS: ReadonlyArray<readonly [ProviderToken<object>, readonly string[]]> =
  [
    [
      OperationLogStoreService,
      [
        '_appliedOpIdsCache',
        '_cacheLastSeq',
        '_unsyncedCache',
        '_unsyncedCacheLastSeq',
        '_vectorClockCache',
      ],
    ],
    [TabSeqFrontierService, ['_frontier', '_hasForeignWrites']],
    [
      OperationLogDownloadService,
      [
        'hasWarnedClockDrift',
        '_hasUnseenRemoteOps',
        '_lastAnnouncedCheckpointSeq',
        'forcedDownloadCheckpoint',
      ],
    ],
    [RejectedOpsHandlerService, ['_resolutionAttemptsByEntity']],
    [OperationCaptureService, ['unrecoveredPersistFailure']],
    [OperationLogEffects, ['inMemoryCompactionCounter', 'compactionFailures']],
  ];

type FieldValues = Map<object, Record<string, unknown>>;

const fieldsOf = (instance: object): Record<string, unknown> =>
  instance as unknown as Record<string, unknown>;

export interface FuzzDevice {
  readonly name: string;
  readonly clientId: string;
  readonly client: FakeSuperSyncClient;
  readonly db: IndexedDbOpLogAdapter;
  state: object;
  fields?: FieldValues;
}

export type FuzzEventKind =
  | 'stop' // UnsupportedMultiEntityConflictError (SYNC_MULTI_ENTITY_UNSUPPORTED)
  | 'sync-error'
  | 'sync-halted'
  | 'full-state' // a SYNC_IMPORT / REPAIR / BACKUP_IMPORT reached the transport
  | 'validation'
  | 'permanent-rejection'
  | 'lww-retries-exhausted'
  | 'dialog'
  | 'error-snack'
  | 'dev-error';

export interface FuzzEvent {
  step: number;
  device: string;
  kind: FuzzEventKind;
  detail: string;
}

/** Deterministic wall clock: each step starts a minute after the previous one. */
class FuzzClock {
  private _stepBase: number;
  private _offset = 0;
  constructor(start: number) {
    this._stepBase = start;
  }
  now(): number {
    return this._stepBase + this._offset++;
  }
  nextStep(): void {
    this._stepBase += 60_000;
    this._offset = 0;
  }
}

const recordingDialog = (onOpen: (name: string) => void): Partial<MatDialog> => ({
  open: ((component: { name?: string }) => {
    onOpen(component?.name ?? 'dialog');
    return { afterClosed: () => of(undefined), close: () => undefined };
  }) as unknown as MatDialog['open'],
  openDialogs: [],
});

export class SyncFuzzHarness {
  readonly server: FakeSuperSyncServer;
  readonly devices: FuzzDevice[] = [];
  readonly events: FuzzEvent[] = [];
  step = 0;
  private _current?: FuzzDevice;
  private readonly _clock: FuzzClock;
  private _pristineState!: object;
  private _pristineFields!: FieldValues;

  private constructor() {
    const realNow = performance.timeOrigin + performance.now();
    this._clock = new FuzzClock(Math.floor(realNow / 60_000) * 60_000);
    (jasmine.isSpy(Date.now)
      ? (Date.now as jasmine.Spy)
      : spyOn(Date, 'now')
    ).and.callFake(() => this._clock.now());
    this.server = new FakeSuperSyncServer(() => Date.now());
  }

  /** Restores the global confirm() default of src/test.ts. */
  static dispose(): void {
    (window.confirm as jasmine.Spy).and.returnValue(true);
  }

  /** Configures TestBed; call from an `it`/`beforeEach` with a fresh module. */
  static async create(): Promise<SyncFuzzHarness> {
    const harness = new SyncFuzzHarness();
    harness._configure();
    await harness._init();
    return harness;
  }

  get current(): FuzzDevice | undefined {
    return this._current;
  }

  tick(): void {
    this.step++;
    this._clock.nextStep();
  }

  record(device: FuzzDevice | undefined, kind: FuzzEventKind, detail: string): void {
    this.events.push({ step: this.step, device: device?.name ?? '-', kind, detail });
  }

  private _configure(): void {
    // A spec may run several traces (shrinking): start from a fresh module and
    // isolate this harness' databases from any earlier harness.
    TestBed.resetTestingModule();
    Object.defineProperty(globalThis, 'indexedDB', {
      value: new IDBFactory(),
      configurable: true,
      writable: true,
    });
    clearDeferredActions();
    const routed = (): OpLogDbAdapter => {
      if (!this._current) throw new Error('SyncFuzz: op-log access outside a device');
      return this._current.db;
    };
    // The services still open their own SUP_OPS connection; it is ignored.
    const routingAdapter = new Proxy({} as OpLogDbAdapter, {
      get: (_target, prop) =>
        prop === 'adoptConnection' || prop === 'close'
          ? () => undefined
          : (...args: unknown[]) => {
              const target = routed() as unknown as Record<
                string | symbol,
                (...a: unknown[]) => unknown
              >;
              return target[prop](...args);
            },
    });
    const clientIds = {
      loadClientId: async () => this._device().clientId,
      getOrGenerateClientId: async () => this._device().clientId,
      clearCache: () => undefined,
    };
    const onDialog = (name: string): void =>
      this.record(this._current, 'dialog', `MatDialog.open(${name})`);
    TestBed.configureTestingModule({
      imports: [
        StoreModule.forRoot(undefined, {
          metaReducers: [deviceStateMetaReducer, ...META_REDUCERS],
        }),
        StoreModule.forFeature(appStateFeature),
        StoreModule.forFeature(CONFIG_FEATURE_NAME, globalConfigReducer),
        StoreModule.forFeature(issueProvidersFeature),
        StoreModule.forFeature(METRIC_FEATURE_NAME, metricReducer),
        StoreModule.forFeature(NOTE_FEATURE_NAME, noteReducer),
        StoreModule.forFeature(PROJECT_FEATURE_NAME, projectReducer),
        StoreModule.forFeature(menuTreeFeatureKey, menuTreeReducer),
        StoreModule.forFeature(SIMPLE_COUNTER_FEATURE_NAME, simpleCounterReducer),
        StoreModule.forFeature(SECTION_FEATURE_NAME, sectionReducer),
        StoreModule.forFeature(TAG_FEATURE_NAME, tagReducer),
        StoreModule.forFeature(TASK_REPEAT_CFG_FEATURE_NAME, taskRepeatCfgReducer),
        StoreModule.forFeature(TASK_FEATURE_NAME, taskReducer),
        StoreModule.forFeature(WORK_CONTEXT_FEATURE_NAME, workContextReducer),
        StoreModule.forFeature(boardsFeature),
        StoreModule.forFeature(timeTrackingFeature),
        StoreModule.forFeature(plannerFeature),
        StoreModule.forFeature(PLUGIN_USER_DATA_FEATURE_NAME, pluginUserDataReducer),
        StoreModule.forFeature(PLUGIN_METADATA_FEATURE_NAME, pluginMetadataReducer),
        StoreModule.forFeature(REMINDER_FEATURE_NAME, reminderReducer),
        EffectsModule.forRoot([]),
        EffectsModule.forFeature([OperationLogEffects, ArchiveOperationHandlerEffects]),
      ],
      providers: [
        { provide: OP_LOG_DB_ADAPTER_FACTORY, useValue: () => routingAdapter },
        { provide: CLIENT_ID_PROVIDER, useValue: clientIds },
        { provide: ClientIdService, useValue: clientIds },
        { provide: ImmediateUploadService, useValue: { trigger: () => undefined } },
        {
          provide: SyncProviderManager,
          useValue: {
            syncEpoch: 0,
            configEpoch: 0,
            isSyncInProgress: false,
            assertSyncEpochUnchanged: () => undefined,
            setSyncStatus: () => undefined,
            bumpSyncEpoch: () => undefined,
          },
        },
        {
          provide: SnackService,
          useValue: {
            open: (params: SnackParams | string) => {
              if (typeof params !== 'string' && params.type === 'ERROR') {
                this.record(this._current, 'error-snack', String(params.msg));
              }
            },
            hasPendingPersistentAction: () => false,
            close: () => undefined,
          },
        },
        { provide: BannerService, useValue: { open: () => undefined } },
        { provide: MatDialog, useValue: recordingDialog(onDialog) },
        {
          provide: TranslateService,
          useValue: {
            instant: (key: string) => key,
            get: (key: string) => of(key),
            stream: (key: string) => of(key),
          },
        },
      ],
    });
  }

  private async _init(): Promise<void> {
    setOperationCaptureService(TestBed.inject(OperationCaptureService));
    // Effects subscribe when the store is created.
    TestBed.inject(OperationLogEffects);
    // Local archive writes (ArchiveOperationHandlerEffects) and triggered
    // compaction run detached from the dispatch; a step must not end, and the
    // device swap out, before they wrote to this device's database.
    this._trackInFlight(TestBed.inject(ArchiveOperationHandler), 'handleOperation');
    this._trackInFlight(TestBed.inject(OperationLogCompactionService), 'compact');
    this._pristineState = await firstValueFrom(TestBed.inject(Store));
    this._pristineFields = new Map();
    for (const [token, names] of DEVICE_FIELDS) {
      const instance = TestBed.inject(token);
      const values: Record<string, unknown> = {};
      for (const name of names) {
        if (!(name in instance)) {
          throw new Error(`SyncFuzz: ${instance.constructor.name}.${name} is gone`);
        }
        values[name] = structuredClone(fieldsOf(instance)[name]);
      }
      this._pristineFields.set(instance, values);
    }
    // devError() confirms before throwing; answer "no" as production builds do
    // and record it. Every other confirm is the fresh-client prompt: accept.
    (window.confirm as jasmine.Spy).and.callFake((message?: string) => {
      if (message?.startsWith('Throw an error for error?')) {
        this.record(this._current, 'dev-error', message.slice(0, 300));
        return false;
      }
      return true;
    });
  }

  private _device(): FuzzDevice {
    if (!this._current) throw new Error('SyncFuzz: no device swapped in');
    return this._current;
  }

  async addDevice(name: string): Promise<FuzzDevice> {
    const connection = await openDB(`SUP_OPS_FUZZ_${name}`, DB_VERSION, {
      upgrade: (db, oldVersion, _newVersion, transaction) =>
        runDbUpgrade(db, oldVersion, transaction),
    });
    const db = new IndexedDbOpLogAdapter();
    db.adoptConnection(connection);
    const device: FuzzDevice = {
      name,
      clientId: `fuzzDev${name}`,
      client: new FakeSuperSyncClient(this.server),
      db,
      state: this._pristineState,
    };
    this.devices.push(device);
    return device;
  }

  /** Runs `fn` as `device`: swap in, run, let capture settle, swap out. */
  async as<T>(device: FuzzDevice, fn: () => Promise<T>): Promise<T> {
    if (this._current) {
      throw new Error(`SyncFuzz: ${device.name} while ${this._current.name} is active`);
    }
    this._current = device;
    TestBed.inject(Store).dispatch({ type: FUZZ_SET_STATE, state: device.state });
    this._restoreFields(device.fields);
    try {
      return await fn();
    } finally {
      await this._settle();
      device.state = await firstValueFrom(TestBed.inject(Store));
      device.fields = this._saveFields();
      this._current = undefined;
    }
  }

  /** Dispatches a local user action on the current device and waits for capture. */
  async dispatch(action: Action | PersistentAction): Promise<void> {
    this._device();
    TestBed.inject(Store).dispatch(action);
    await this._settle();
  }

  state(): Promise<Record<string, unknown>> {
    return firstValueFrom(TestBed.inject(Store)) as Promise<Record<string, unknown>>;
  }

  private readonly _inFlight = new Set<Promise<unknown>>();

  private _trackInFlight<T extends object>(instance: T, method: keyof T & string): void {
    const target = instance as unknown as Record<string, (...a: unknown[]) => unknown>;
    const original = target[method].bind(instance);
    target[method] = (...args: unknown[]) => {
      const result = Promise.resolve(original(...args));
      this._inFlight.add(result);
      void result.finally(() => this._inFlight.delete(result)).catch(() => undefined);
      return result;
    };
  }

  private async _settle(): Promise<void> {
    do {
      await TestBed.inject(OperationWriteFlushService).flushPendingWrites();
      await Promise.allSettled([...this._inFlight]);
    } while (this._inFlight.size > 0);
    if (getDeferredActions().length > 0) {
      await TestBed.inject(OperationLogEffects).processDeferredActions();
    }
    if (TestBed.inject(HydrationStateService).isApplyingRemoteOps()) {
      throw new Error('SyncFuzz: remote apply still open at a step boundary');
    }
  }

  private _saveFields(): FieldValues {
    const saved: FieldValues = new Map();
    for (const instance of this._pristineFields.keys()) {
      const values: Record<string, unknown> = {};
      for (const name of Object.keys(this._pristineFields.get(instance)!)) {
        values[name] = fieldsOf(instance)[name];
      }
      saved.set(instance, values);
    }
    return saved;
  }

  private _restoreFields(saved?: FieldValues): void {
    for (const [instance, pristine] of this._pristineFields) {
      const values = saved?.get(instance) ?? structuredClone(pristine);
      Object.assign(fieldsOf(instance), values);
    }
  }

  /**
   * One sync as SyncWrapperService._syncBody runs it for SuperSync: download,
   * upload, then the bounded re-upload of local-win / transiently rejected ops.
   * Returns false when sync did not complete cleanly (see `events`).
   */
  async sync(device: FuzzDevice): Promise<boolean> {
    const before = this.events.length;
    await this.as(device, async () => {
      const syncService = TestBed.inject(OperationLogSyncService);
      const session = TestBed.inject(SyncSessionValidationService);
      try {
        await session.withSession(async () => {
          const isNeverSynced = !(await syncService.hasSyncedOps());
          const down = await syncService.downloadRemoteOps(device.client, {
            isNeverSynced,
            keepDecryptedPrefix: true,
          });
          if (down.kind === 'cancelled' || down.kind === 'blocked_incompatible') {
            this.record(device, 'sync-halted', `download ${down.kind}`);
            return;
          }
          let up = await syncService.uploadPendingOps(device.client, { isNeverSynced });
          const permanent = (): void => {
            if (up.kind === 'completed' && up.permanentRejectionCount > 0) {
              this.record(
                device,
                'permanent-rejection',
                `${up.permanentRejectionCount} op(s): ` +
                  up.rejectedOps.map((r) => r.errorCode).join(','),
              );
            }
          };
          permanent();
          let pending =
            (down.kind === 'ops_processed' ? down.localWinOpsCreated : 0) +
            (up.kind === 'completed'
              ? up.localWinOpsCreated + countTransientRejections(up)
              : 0);
          for (let retry = 0; pending > 0 && retry < MAX_LWW_REUPLOAD_RETRIES; retry++) {
            up = await syncService.uploadPendingOps(device.client, { isNeverSynced });
            permanent();
            pending =
              up.kind === 'completed'
                ? up.localWinOpsCreated + countTransientRejections(up)
                : 0;
          }
          if (pending > 0) {
            this.record(
              device,
              'lww-retries-exhausted',
              `${pending} op(s) still pending`,
            );
          }
          if (up.kind !== 'completed')
            this.record(device, 'sync-halted', `upload ${up.kind}`);
          if (session.hasFailed())
            this.record(device, 'validation', 'state invalid after sync');
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof UnsupportedMultiEntityConflictError) {
          this.record(device, 'stop', message);
        } else if (e instanceof FuzzUnsupportedTransportError) {
          this.record(device, 'full-state', message);
        } else {
          this.record(device, 'sync-error', `${(e as Error)?.name}: ${message}`);
        }
      }
    });
    return this.events.length === before;
  }

  /** Synced state (the snapshot sync ships, archives included). */
  async syncedState(device: FuzzDevice): Promise<AppStateSnapshot> {
    return this.as(device, () =>
      TestBed.inject(StateSnapshotService).getStateSnapshotAsync(),
    );
  }

  async pendingOpCount(device: FuzzDevice): Promise<number> {
    return this.as(
      device,
      async () => (await TestBed.inject(OperationLogStoreService).getUnsynced()).length,
    );
  }
}
