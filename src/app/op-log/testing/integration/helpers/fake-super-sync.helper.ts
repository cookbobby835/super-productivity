import { compareVectorClocks } from '@sp/sync-core';
import { IDBPDatabase, openDB } from 'idb';
import { VectorClock } from '../../../core/operation.types';
import { DB_VERSION } from '../../../persistence/db-keys.const';
import { runDbUpgrade } from '../../../persistence/db-upgrade';
import { OperationLogStoreService } from '../../../persistence/operation-log-store.service';
import { SyncProviderId } from '../../../sync-providers/provider.const';
import {
  SuperSyncOpDownloadResponse,
  OperationSyncCapable,
  OpUploadResponse,
  OpUploadResult,
  ServerSyncOperation,
  SyncOperation,
  SyncProviderBase,
} from '../../../sync-providers/provider.interface';

const TASK_TIME_DELTA_ACTION_TYPE = '[TimeTracking] Sync time spent';
const FULL_STATE_OP_TYPES = new Set(['SYNC_IMPORT', 'BACKUP_IMPORT', 'REPAIR']);

/**
 * In-memory SuperSync server for integration tests. Per uploaded op it decides
 * like `OperationUploadService.processOperation` and `detectConflict`
 * (packages/super-sync-server/src/sync/): duplicate id first, then the latest
 * stored op of every entity the op names, compared by vector clock.
 * CONCURRENT (or EQUAL from another client) is `CONFLICT_CONCURRENT` and
 * LESS_THAN is `CONFLICT_SUPERSEDED`, both with `existingClock`; two concurrent
 * task time deltas commute. Validation, quotas, clock pruning and timestamp
 * clamping are not modeled.
 */
export class FakeSuperSyncServer {
  private readonly stored: ServerSyncOperation[] = [];
  /** Every rejection so far, as `errorCode actionType`, for failure reports. */
  readonly rejections: string[] = [];

  get latestSeq(): number {
    return this.stored.length;
  }

  get ops(): readonly ServerSyncOperation[] {
    return this.stored;
  }

  upload(
    ops: SyncOperation[],
    clientId: string,
    lastKnownServerSeq?: number,
  ): OpUploadResponse {
    const results = ops.map((op) => this.processOperation(op));
    const newOps =
      lastKnownServerSeq === undefined
        ? undefined
        : this.stored.filter(
            (stored) =>
              stored.serverSeq > lastKnownServerSeq && stored.op.clientId !== clientId,
          );
    return {
      results,
      newOps: newOps?.length ? newOps : undefined,
      latestSeq: this.latestSeq,
    };
  }

  download(
    sinceSeq: number,
    excludeClient?: string,
    limit = 500,
  ): SuperSyncOpDownloadResponse {
    const matching = this.stored.filter(
      (stored) => stored.serverSeq > sinceSeq && stored.op.clientId !== excludeClient,
    );
    return {
      ops: matching.slice(0, limit),
      hasMore: matching.length > limit,
      latestSeq: this.latestSeq,
      gapDetected: sinceSeq > this.latestSeq,
    };
  }

  private processOperation(op: SyncOperation): OpUploadResult {
    const reject = (
      errorCode: string,
      error: string,
      existingClock?: VectorClock,
    ): OpUploadResult => {
      this.rejections.push(`${errorCode} ${op.actionType}`);
      return { opId: op.id, accepted: false, error, errorCode, existingClock };
    };

    const duplicate = this.stored.find((stored) => stored.op.id === op.id);
    if (duplicate) {
      return JSON.stringify(duplicate.op) === JSON.stringify(op)
        ? reject('DUPLICATE_OPERATION', 'Duplicate operation ID')
        : reject(
            'INVALID_OP_ID',
            'Operation ID already belongs to a different operation',
          );
    }

    if (!FULL_STATE_OP_TYPES.has(op.opType)) {
      const entityIds = new Set([
        ...(op.entityId ? [op.entityId] : []),
        ...(op.entityIds ?? []),
      ]);
      for (const entityId of entityIds) {
        const existing = this.latestOpFor(op.entityType, entityId);
        if (!existing) {
          continue;
        }
        const comparison = compareVectorClocks(op.vectorClock, existing.vectorClock);
        if (
          comparison === 'GREATER_THAN' ||
          (comparison === 'EQUAL' && op.clientId === existing.clientId) ||
          (comparison === 'CONCURRENT' &&
            op.actionType === TASK_TIME_DELTA_ACTION_TYPE &&
            existing.actionType === TASK_TIME_DELTA_ACTION_TYPE)
        ) {
          continue;
        }
        return comparison === 'LESS_THAN'
          ? reject('CONFLICT_SUPERSEDED', 'Superseded operation', existing.vectorClock)
          : reject(
              'CONFLICT_CONCURRENT',
              'Concurrent modification',
              existing.vectorClock,
            );
      }
    }

    const serverSeq = this.stored.length + 1;
    this.stored.push({ serverSeq, op, receivedAt: serverSeq });
    return { opId: op.id, accepted: true, serverSeq };
  }

  private latestOpFor(entityType: string, entityId: string): SyncOperation | undefined {
    for (let i = this.stored.length - 1; i >= 0; i--) {
      const { op } = this.stored[i];
      if (
        op.entityType === entityType &&
        (op.entityId === entityId || !!op.entityIds?.includes(entityId))
      ) {
        return op;
      }
    }
    return undefined;
  }
}

/** One device's SuperSync connection to a shared {@link FakeSuperSyncServer}. */
export class FakeSuperSyncProvider
  implements SyncProviderBase<SyncProviderId>, OperationSyncCapable<'superSyncOps'>
{
  readonly id = SyncProviderId.SuperSync;
  readonly supportsOperationSync = true;
  readonly providerMode = 'superSyncOps' as const;
  readonly maxConcurrentRequests = 1;
  readonly isEncryptionMandatory = false;
  readonly privateCfg = {
    load: async () => ({
      accessToken: 'test-token',
      baseUrl: 'https://supersync.test',
      isEncryptionEnabled: false,
      encryptKey: undefined,
    }),
  } as unknown as SyncProviderBase<SyncProviderId>['privateCfg'];
  private lastServerSeq = 0;

  constructor(private readonly server: FakeSuperSyncServer) {}

  async getLastServerSeq(): Promise<number> {
    return this.lastServerSeq;
  }

  async setLastServerSeq(seq: number): Promise<void> {
    this.lastServerSeq = seq;
  }

  async uploadOps(
    ops: SyncOperation[],
    clientId: string,
    lastKnownServerSeq?: number,
  ): Promise<OpUploadResponse> {
    // Wire copies: nothing the client later mutates may reach stored ops.
    return this.server.upload(structuredClone(ops), clientId, lastKnownServerSeq);
  }

  async downloadOps(
    sinceSeq: number,
    excludeClient?: string,
    limit?: number,
  ): Promise<SuperSyncOpDownloadResponse> {
    return structuredClone(this.server.download(sinceSeq, excludeClient, limit));
  }

  async uploadSnapshot(): Promise<never> {
    throw new Error('HARNESS: snapshot uploads are not modeled');
  }

  async deleteAllData(): Promise<never> {
    throw new Error('HARNESS: deleteAllData is not modeled');
  }

  async getEncryptKey(): Promise<undefined> {
    return undefined;
  }

  async isEncryptionEnabled(): Promise<boolean> {
    return false;
  }

  async isReady(): Promise<boolean> {
    return true;
  }

  async setPrivateCfg(): Promise<void> {}
}

/**
 * Gives one OperationLogStoreService its own IndexedDB database, so each
 * simulated device owns its op log like a separate app instance. Uses the
 * store's `_openDbOnce` testing seam. Returns a cleanup that closes and
 * deletes the database.
 */
export const useOwnOpLogDatabase = async (
  store: OperationLogStoreService,
  name: string,
): Promise<() => Promise<void>> => {
  const seam = store as unknown as {
    _openDbOnce: () => Promise<IDBPDatabase<unknown>>;
    _db?: IDBPDatabase<unknown>;
  };
  seam._openDbOnce = () =>
    openDB<unknown>(name, DB_VERSION, {
      upgrade: (db, oldVersion, _newVersion, transaction) =>
        runDbUpgrade(
          db as unknown as Parameters<typeof runDbUpgrade>[0],
          oldVersion,
          transaction as unknown as Parameters<typeof runDbUpgrade>[2],
        ),
    });
  await store.init();
  return async () => {
    seam._db?.close();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  };
};
