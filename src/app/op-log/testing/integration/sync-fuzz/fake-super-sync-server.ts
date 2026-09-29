import {
  compareVectorClocks,
  // The server prunes the clocks it stores; this port of it never touches a
  // durable client clock.
  // eslint-disable-next-line no-restricted-imports
  limitVectorClockSize,
  MAX_VECTOR_CLOCK_SIZE,
  VectorClock,
} from '@sp/sync-core';
import type {
  OperationSyncCapable,
  OpUploadResponse,
  OpUploadResult,
  ServerSyncOperation,
  SnapshotUploadResponse,
  SuperSyncOpDownloadResponse,
  SyncOperation,
} from '@sp/sync-providers/provider-types';

/**
 * In-memory SuperSync server for the sync fuzz harness.
 *
 * The decision logic is a PORT of packages/super-sync-server (conflict.ts,
 * services/operation-upload.service.ts, sync.service.ts uploadOps,
 * sync.routes.ops-handler.ts, services/operation-download.service.ts). It
 * cannot be imported into the Karma bundle: those modules pull in Prisma and a
 * node `fs` logger. packages/super-sync-server/tests/sync-fuzz-server-parity.pglite.spec.ts
 * runs this port against the real server functions (the conflict SQL on
 * PGlite) — keep both in step when the server changes.
 *
 * This file must stay free of Angular imports so the server's vitest can load it.
 */

export const TASK_TIME_DELTA_ACTION_TYPE = '[TimeTracking] Sync time spent';
export const CONFLICT_DETECTION_ENTITY_BATCH_SIZE = 100;
const MAX_CLOCK_DRIFT_MS = 60 * 1000; // DEFAULT_SYNC_CONFIG.maxClockDriftMs
const MISC_TASKS_SPLIT_SCHEMA_VERSION = 2;
const PIGGYBACK_LIMIT = 500;
const FULL_STATE_OP_TYPES = new Set(['SYNC_IMPORT', 'BACKUP_IMPORT', 'REPAIR']);
export const STATE_REPLACEMENT_REQUIRED_ERROR =
  'Download the latest full-state replacement before retrying';

export type ConflictType =
  | 'concurrent'
  | 'superseded'
  | 'equal_different_client'
  | 'unknown';

export interface ConflictResult {
  hasConflict: boolean;
  reason?: string;
  conflictType?: ConflictType;
  existingClock?: VectorClock;
}

/** A persisted row, in the shape the real server stores and compares. */
export interface StoredOperation {
  serverSeq: number;
  receivedAt: number;
  clientTimestamp: number;
  /** Stored with the pruned clock and normalized `entityIds` (getStoredEntityIds). */
  op: SyncOperation;
}

// ---------------------------------------------------------------------------
// conflict.ts — ported verbatim in behavior
// ---------------------------------------------------------------------------

export const resolveConflictForExistingOp = (
  op: SyncOperation,
  entityId: string,
  existingOp: { actionType?: string; clientId: string; vectorClock: unknown },
): ConflictResult => {
  const existingClock = existingOp.vectorClock as VectorClock;
  const comparison = compareVectorClocks(op.vectorClock, existingClock);
  if (
    comparison === 'CONCURRENT' &&
    op.actionType === TASK_TIME_DELTA_ACTION_TYPE &&
    existingOp.actionType === TASK_TIME_DELTA_ACTION_TYPE
  ) {
    return { hasConflict: false };
  }
  if (comparison === 'GREATER_THAN') return { hasConflict: false };
  if (comparison === 'EQUAL' && op.clientId === existingOp.clientId) {
    return { hasConflict: false };
  }
  const entity = `${op.entityType}:${entityId}`;
  if (comparison === 'EQUAL') {
    return {
      hasConflict: true,
      conflictType: 'equal_different_client',
      reason: `Equal vector clocks from different clients for ${entity} (client ${op.clientId} vs ${existingOp.clientId})`,
      existingClock,
    };
  }
  if (comparison === 'CONCURRENT') {
    return {
      hasConflict: true,
      conflictType: 'concurrent',
      reason: `Concurrent modification detected for ${entity}`,
      existingClock,
    };
  }
  if (comparison === 'LESS_THAN') {
    return {
      hasConflict: true,
      conflictType: 'superseded',
      reason: `Superseded operation: server has newer version of ${entity}`,
      existingClock,
    };
  }
  return {
    hasConflict: true,
    conflictType: 'unknown',
    reason: `Unknown vector clock comparison result for ${entity}`,
    existingClock,
  };
};

const isLegacyMiscConfigOperation = (op: SyncOperation): boolean =>
  op.schemaVersion < MISC_TASKS_SPLIT_SCHEMA_VERSION &&
  op.entityType === 'GLOBAL_CONFIG' &&
  op.entityId === 'misc';

export const getConflictEntityIds = (op: SyncOperation): string[] => {
  const raw = [
    ...(op.entityId ? [op.entityId] : []),
    ...(op.entityIds?.length ? op.entityIds : []),
  ];
  if (isLegacyMiscConfigOperation(op)) raw.push('tasks');
  return Array.from(new Set(raw));
};

export const getStoredEntityIds = (op: SyncOperation): string[] => {
  const ids = Array.from(
    new Set(op.entityIds?.length ? op.entityIds : op.entityId ? [op.entityId] : []),
  );
  return ids.length <= 1 && ids[0] === op.entityId ? [] : ids;
};

export const toStableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => toStableJsonValue(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, toStableJsonValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
};

export const stableJsonStringify = (value: unknown): string =>
  JSON.stringify(toStableJsonValue(value)) ?? 'undefined';

const areJsonValuesEqual = (a: unknown, b: unknown): boolean =>
  stableJsonStringify(a) === stableJsonStringify(b);

export const isSameDuplicateTimestamp = (
  existingTimestamp: number,
  existingReceivedAt: number,
  incomingStoredTimestamp: number,
  incomingOriginalTimestamp: number,
  maxClockDriftMs: number,
): boolean =>
  existingTimestamp === incomingStoredTimestamp ||
  (existingTimestamp === existingReceivedAt + maxClockDriftMs &&
    existingTimestamp <= incomingOriginalTimestamp);

/** isSameDuplicateOperation, minus the userId check (one user per fake server). */
export const isSameDuplicateOperation = (
  existing: StoredOperation,
  op: SyncOperation,
  maxClockDriftMs: number,
  originalTimestamp: number = op.timestamp,
): boolean => {
  const storedClock = existing.op.vectorClock;
  const storedVectorClock = limitVectorClockSize(op.vectorClock, [
    op.clientId,
    ...(storedClock && typeof storedClock === 'object' ? Object.keys(storedClock) : []),
  ]);
  const incomingEncrypted = op.isPayloadEncrypted ?? false;
  const existingEncrypted = existing.op.isPayloadEncrypted ?? false;
  const payloadsMatch =
    (existingEncrypted && incomingEncrypted) ||
    areJsonValuesEqual(existing.op.payload, op.payload);
  return (
    existing.op.clientId === op.clientId &&
    existing.op.actionType === op.actionType &&
    existing.op.opType === op.opType &&
    existing.op.entityType === op.entityType &&
    (existing.op.entityId ?? null) === (op.entityId ?? null) &&
    areJsonValuesEqual(existing.op.entityIds ?? [], getStoredEntityIds(op)) &&
    payloadsMatch &&
    areJsonValuesEqual(existing.op.vectorClock, storedVectorClock) &&
    existing.op.schemaVersion === op.schemaVersion &&
    isSameDuplicateTimestamp(
      existing.clientTimestamp,
      existing.receivedAt,
      op.timestamp,
      originalTimestamp,
      maxClockDriftMs,
    ) &&
    existingEncrypted === incomingEncrypted &&
    (existing.op.syncImportReason ?? null) === (op.syncImportReason ?? null) &&
    (existing.op.repairBaseServerSeq ?? null) === (op.repairBaseServerSeq ?? null)
  );
};

export const isSameIncomingOperation = (
  first: SyncOperation,
  second: SyncOperation,
  firstOriginalTimestamp: number = first.timestamp,
  secondOriginalTimestamp: number = second.timestamp,
): boolean => {
  const bothEncrypted =
    (first.isPayloadEncrypted ?? false) && (second.isPayloadEncrypted ?? false);
  return (
    first.clientId === second.clientId &&
    first.actionType === second.actionType &&
    first.opType === second.opType &&
    first.entityType === second.entityType &&
    first.entityId === second.entityId &&
    areJsonValuesEqual(getStoredEntityIds(first), getStoredEntityIds(second)) &&
    (bothEncrypted || areJsonValuesEqual(first.payload, second.payload)) &&
    areJsonValuesEqual(
      limitVectorClockSize(first.vectorClock, [first.clientId]),
      limitVectorClockSize(second.vectorClock, [second.clientId]),
    ) &&
    first.schemaVersion === second.schemaVersion &&
    firstOriginalTimestamp === secondOriginalTimestamp &&
    (first.isPayloadEncrypted ?? false) === (second.isPayloadEncrypted ?? false) &&
    (first.syncImportReason ?? null) === (second.syncImportReason ?? null) &&
    (first.repairBaseServerSeq ?? null) === (second.repairBaseServerSeq ?? null)
  );
};

const isValidCalendarDate = (value: unknown): boolean => {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return (
    month >= 1 && month <= 12 && day >= 1 && day <= new Date(year, month, 0).getDate()
  );
};

/**
 * The part of services/validation.service.ts validateOp that ops built by the
 * app can plausibly fail. Payload size/complexity limits and the entity-type
 * allowlist are not ported: fuzz payloads are small and use real action types.
 */
export const validateOpSubset = (
  op: SyncOperation,
  requestClientId: string,
): { errorCode: string; error: string } | undefined => {
  if (op.clientId !== requestClientId) {
    return { errorCode: 'INVALID_CLIENT_ID', error: 'clientId does not match request' };
  }
  const isFullState = FULL_STATE_OP_TYPES.has(op.opType);
  const isBulk = op.entityType === 'ALL' || op.entityType === 'RECOVERY';
  if (op.entityId !== undefined && op.entityId !== null && !op.entityId.trim()) {
    return { errorCode: 'INVALID_ENTITY_ID', error: 'empty entityId' };
  }
  if ((op.entityIds ?? []).some((id) => typeof id !== 'string' || !id.trim())) {
    return { errorCode: 'INVALID_ENTITY_ID', error: 'invalid entityIds element' };
  }
  if (!isFullState && !isBulk && !op.entityId) {
    return { errorCode: 'MISSING_ENTITY_ID', error: 'requires entityId' };
  }
  if (op.payload === undefined) {
    return { errorCode: 'INVALID_PAYLOAD', error: 'Missing payload' };
  }
  if (op.actionType === TASK_TIME_DELTA_ACTION_TYPE && !op.isPayloadEncrypted) {
    const wrapper = op.payload as Record<string, unknown> | null;
    const inner = wrapper?.['actionPayload'];
    const p = (inner && typeof inner === 'object' ? inner : wrapper) as Record<
      string,
      unknown
    > | null;
    const duration = p?.['duration'];
    if (
      !p ||
      p['taskId'] !== op.entityId ||
      !isValidCalendarDate(p['date']) ||
      typeof duration !== 'number' ||
      !Number.isFinite(duration) ||
      duration < 0
    ) {
      return { errorCode: 'INVALID_PAYLOAD', error: 'Invalid task-time sync payload' };
    }
  }
  if (
    op.schemaVersion !== undefined &&
    (!Number.isInteger(op.schemaVersion) ||
      op.schemaVersion < 1 ||
      op.schemaVersion > 100)
  ) {
    return { errorCode: 'INVALID_SCHEMA_VERSION', error: 'Invalid schema version' };
  }
  if (!Number.isSafeInteger(op.timestamp)) {
    return { errorCode: 'INVALID_TIMESTAMP', error: 'Invalid timestamp' };
  }
  return undefined;
};

const isCausalFullState = (op: SyncOperation): boolean =>
  op.opType === 'SYNC_IMPORT' ||
  op.opType === 'BACKUP_IMPORT' ||
  (op.opType === 'REPAIR' && op.repairBaseServerSeq !== undefined);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// ---------------------------------------------------------------------------
// The server: one user, one op table
// ---------------------------------------------------------------------------

export interface FakeServerRejection {
  clientId: string;
  opId: string;
  actionType: string;
  entity: string;
  errorCode: string;
}

export class FakeSuperSyncServer {
  readonly rows: StoredOperation[] = [];
  /** Every rejection, for oracles and failure reports. */
  readonly rejections: FakeServerRejection[] = [];
  /** Full-state uploads (SYNC_IMPORT / BACKUP_IMPORT / REPAIR) the fuzz never expects. */
  readonly fullStateUploads: SyncOperation[] = [];
  private _lastSeq = 0;
  private _latestStateReplacementSeq = 0;

  constructor(private readonly _now: () => number = () => Date.now()) {}

  get latestSeq(): number {
    return this.rows.length ? this._lastSeq : 0;
  }

  /** The latest op touching `entityType:entityId` via entity_id or entity_ids. */
  latestEntityOp(entityType: string, entityId: string): StoredOperation | undefined {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const { op } = this.rows[i];
      if (
        op.entityType === entityType &&
        (op.entityId === entityId || (op.entityIds ?? []).includes(entityId))
      ) {
        return this.rows[i];
      }
    }
    return undefined;
  }

  /** conflict.ts detectConflict. */
  detectConflict(op: SyncOperation): ConflictResult {
    if (FULL_STATE_OP_TYPES.has(op.opType)) return { hasConflict: false };
    const entityIds = getConflictEntityIds(op);
    if (entityIds.length === 1 || isLegacyMiscConfigOperation(op)) {
      for (const entityId of entityIds) {
        const result = this._detectConflictForEntity(op, entityId);
        if (result.hasConflict) return result;
      }
      return { hasConflict: false };
    }
    // detectConflictForEntities: batches of 100, first conflict wins.
    for (const entityId of entityIds) {
      const existing = this.latestEntityOp(op.entityType, entityId);
      if (!existing) continue;
      const result = resolveConflictForExistingOp(op, entityId, existing.op);
      if (result.hasConflict) return result;
    }
    return { hasConflict: false };
  }

  /** detectConflictForEntity, including its pre-v2 GLOBAL_CONFIG:misc alias. */
  private _detectConflictForEntity(op: SyncOperation, entityId: string): ConflictResult {
    let existing = this.latestEntityOp(op.entityType, entityId);
    if (op.entityType === 'GLOBAL_CONFIG' && entityId === 'tasks') {
      const legacy = [...this.rows]
        .reverse()
        .find(
          (row) =>
            row.op.entityType === 'GLOBAL_CONFIG' &&
            row.op.entityId === 'misc' &&
            row.op.schemaVersion < MISC_TASKS_SPLIT_SCHEMA_VERSION,
        );
      if (legacy && (!existing || legacy.serverSeq > existing.serverSeq)) {
        existing = legacy;
      }
    }
    return existing
      ? resolveConflictForExistingOp(op, entityId, existing.op)
      : { hasConflict: false };
  }

  /** POST /api/sync/ops: sync.service.ts uploadOps + the route's piggyback. */
  uploadOps(
    rawOps: SyncOperation[],
    clientId: string,
    lastKnownServerSeq?: number,
  ): OpUploadResponse {
    const ops = clone(rawOps);
    const now = this._now();
    let results: OpUploadResult[];
    if (
      lastKnownServerSeq !== undefined &&
      lastKnownServerSeq < this._latestStateReplacementSeq
    ) {
      results = ops.map((op) => ({
        opId: op.id,
        accepted: false,
        error: STATE_REPLACEMENT_REQUIRED_ERROR,
        errorCode: 'INTERNAL_ERROR',
      }));
    } else {
      const firstById = new Map<string, { op: SyncOperation; ts: number }>();
      results = ops.map((op) => {
        const first = firstById.get(op.id);
        if (!first) firstById.set(op.id, { op: { ...op }, ts: op.timestamp });
        return this._processOperation(clientId, op, now, first);
      });
      ops.forEach((op, i) => {
        if (
          results[i].accepted &&
          (op.opType === 'SYNC_IMPORT' || op.opType === 'BACKUP_IMPORT')
        ) {
          this._latestStateReplacementSeq = results[i].serverSeq!;
        }
      });
    }
    const requiresReplacementDownload =
      results.length > 0 &&
      results.every(
        (r) =>
          !r.accepted &&
          r.errorCode === 'INTERNAL_ERROR' &&
          r.error === STATE_REPLACEMENT_REQUIRED_ERROR,
      );
    let newOps: ServerSyncOperation[] | undefined;
    let latestSeq = this.latestSeq;
    let hasMorePiggyback = false;
    if (lastKnownServerSeq !== undefined) {
      const piggyback = this.getOpsSinceWithSeq(
        lastKnownServerSeq,
        requiresReplacementDownload ? undefined : clientId,
        PIGGYBACK_LIMIT,
        false,
      );
      newOps = piggyback.ops;
      latestSeq = piggyback.latestSeq;
      if (newOps.length === PIGGYBACK_LIMIT) {
        hasMorePiggyback = newOps[newOps.length - 1].serverSeq < latestSeq;
      }
    }
    return clone({
      results,
      newOps: newOps && newOps.length > 0 ? newOps : undefined,
      latestSeq,
      ...(hasMorePiggyback ? { hasMorePiggyback: true } : {}),
    });
  }

  /** services/operation-upload.service.ts processOperation. */
  private _processOperation(
    clientId: string,
    op: SyncOperation,
    now: number,
    firstRequestOperation?: { op: SyncOperation; ts: number },
  ): OpUploadResult {
    const originalTimestamp = op.timestamp;
    if (op.timestamp > now + MAX_CLOCK_DRIFT_MS) op.timestamp = now + MAX_CLOCK_DRIFT_MS;
    const reject = (
      errorCode: string,
      error: string,
      existingClock?: VectorClock,
    ): OpUploadResult => {
      this.rejections.push({
        clientId,
        opId: op.id,
        actionType: op.actionType,
        entity: `${op.entityType}:${op.entityId ?? (op.entityIds ?? []).join(',')}`,
        errorCode,
      });
      return { opId: op.id, accepted: false, error, errorCode, existingClock };
    };
    if (firstRequestOperation) {
      return isSameIncomingOperation(
        firstRequestOperation.op,
        op,
        firstRequestOperation.ts,
        originalTimestamp,
      )
        ? reject('DUPLICATE_OPERATION', 'Duplicate operation ID')
        : reject(
            'INVALID_OP_ID',
            'Operation ID already belongs to a different operation',
          );
    }
    const invalid = validateOpSubset(op, clientId);
    if (invalid) return reject(invalid.errorCode, invalid.error);
    const existing = this.rows.find((row) => row.op.id === op.id);
    if (existing) {
      return isSameDuplicateOperation(existing, op, MAX_CLOCK_DRIFT_MS, originalTimestamp)
        ? reject('DUPLICATE_OPERATION', 'Duplicate operation ID')
        : reject(
            'INVALID_OP_ID',
            'Operation ID already belongs to a different operation',
          );
    }
    const conflict = this.detectConflict(op);
    if (conflict.hasConflict) {
      const code =
        conflict.conflictType === 'concurrent' ||
        conflict.conflictType === 'equal_different_client'
          ? 'CONFLICT_CONCURRENT'
          : 'CONFLICT_SUPERSEDED';
      return reject(code, conflict.reason ?? code, conflict.existingClock);
    }
    const serverSeq = ++this._lastSeq;
    // Pruning runs AFTER comparison, BEFORE storage. The active causal
    // full-state author is protected only for oversized clocks.
    const protectedIds =
      Object.keys(op.vectorClock).length > MAX_VECTOR_CLOCK_SIZE
        ? [...this.rows].reverse().find((row) => isCausalFullState(row.op))?.op.clientId
        : undefined;
    const stored: SyncOperation = {
      ...op,
      vectorClock: limitVectorClockSize(op.vectorClock, [
        op.clientId,
        ...(protectedIds ? [protectedIds] : []),
      ]),
      entityIds: getStoredEntityIds(op),
      isPayloadEncrypted: op.isPayloadEncrypted ?? false,
    };
    this.rows.push({
      serverSeq,
      receivedAt: now,
      clientTimestamp: op.timestamp,
      op: stored,
    });
    return { opId: op.id, accepted: true, serverSeq };
  }

  /** services/operation-download.service.ts getOpsSinceWithSeq (no snapshot clock). */
  getOpsSinceWithSeq(
    sinceSeq: number,
    excludeClient: string | undefined,
    limit: number,
    includeSnapshotMetadata: boolean,
  ): {
    ops: ServerSyncOperation[];
    latestSeq: number;
    gapDetected: boolean;
    snapshotVectorClock?: VectorClock;
  } {
    const latestSeq = this._lastSeq;
    if (latestSeq === 0) return { ops: [], latestSeq, gapDetected: sinceSeq > 0 };
    const snapshotRow = [...this.rows].reverse().find((row) => isCausalFullState(row.op));
    let effectiveSinceSeq = sinceSeq;
    let snapshotVectorClock: VectorClock | undefined;
    if (snapshotRow && sinceSeq < snapshotRow.serverSeq) {
      effectiveSinceSeq = snapshotRow.serverSeq - 1;
      if (includeSnapshotMetadata) {
        // The server persists the aggregate of every prior clock plus the op's own.
        const aggregate: VectorClock = {};
        for (const row of this.rows.filter((r) => r.serverSeq <= snapshotRow.serverSeq)) {
          for (const [id, counter] of Object.entries(row.op.vectorClock)) {
            aggregate[id] = Math.max(aggregate[id] ?? 0, counter);
          }
        }
        snapshotVectorClock = limitVectorClockSize(aggregate, [
          ...(excludeClient ? [excludeClient] : []),
          snapshotRow.op.clientId,
        ]);
      }
    }
    const ops = this.rows
      .filter(
        (row) =>
          row.serverSeq > effectiveSinceSeq &&
          row.serverSeq <= latestSeq &&
          (!excludeClient || row.op.clientId !== excludeClient),
      )
      .slice(0, limit)
      .map((row) => this._toServerOp(row));
    const minSeq = this.rows.length ? this.rows[0].serverSeq : null;
    if (ops.length === 0 && minSeq === null) {
      return { ops: [], latestSeq: 0, gapDetected: sinceSeq > 0 };
    }
    let gapDetected = sinceSeq > latestSeq && latestSeq > 0;
    if (sinceSeq > 0 && latestSeq > 0) {
      if (minSeq !== null && effectiveSinceSeq < minSeq - 1) gapDetected = true;
      if (!excludeClient && ops.length > 0 && ops[0].serverSeq > effectiveSinceSeq + 1) {
        gapDetected = true;
      }
    }
    return { ops, latestSeq, gapDetected, snapshotVectorClock };
  }

  /** GET /api/sync/ops (sync.routes.ts): limit+1 probe for `hasMore`. */
  downloadOps(
    sinceSeq: number,
    excludeClient?: string,
    limit: number = 500,
  ): SuperSyncOpDownloadResponse {
    const maxLimit = Math.min(limit, 1000);
    const result = this.getOpsSinceWithSeq(sinceSeq, excludeClient, maxLimit + 1, true);
    const hasMore = result.ops.length > maxLimit;
    if (hasMore) result.ops.pop();
    return clone({
      ops: result.ops,
      hasMore,
      latestSeq: result.latestSeq,
      gapDetected: result.gapDetected || undefined,
      snapshotVectorClock: result.snapshotVectorClock,
      serverTime: this._now(),
      capabilities: { causalRepairSnapshots: true },
    });
  }

  private _toServerOp(row: StoredOperation): ServerSyncOperation {
    const { entityIds, ...op } = row.op;
    return {
      serverSeq: row.serverSeq,
      receivedAt: row.receivedAt,
      op: { ...op, ...(entityIds && entityIds.length ? { entityIds } : {}) },
    };
  }
}

/** Thrown for the transports the fuzz does not model (full-state replacement). */
export class FuzzUnsupportedTransportError extends Error {}

/** One device's SuperSync client: own cursor, shared server, JSON on the wire. */
export class FakeSuperSyncClient implements OperationSyncCapable<'superSyncOps'> {
  readonly supportsOperationSync = true;
  readonly providerMode = 'superSyncOps' as const;
  private _lastServerSeq = 0;

  constructor(private readonly _server: FakeSuperSyncServer) {}

  async uploadOps(
    ops: SyncOperation[],
    clientId: string,
    lastKnownServerSeq?: number,
  ): Promise<OpUploadResponse> {
    return this._server.uploadOps(ops, clientId, lastKnownServerSeq);
  }

  async downloadOps(
    sinceSeq: number,
    excludeClient?: string,
    limit?: number,
  ): Promise<SuperSyncOpDownloadResponse> {
    return this._server.downloadOps(sinceSeq, excludeClient, limit);
  }

  async getLastServerSeq(): Promise<number> {
    return this._lastServerSeq;
  }

  async setLastServerSeq(seq: number): Promise<void> {
    this._lastServerSeq = seq;
  }

  supportsCausalRepairSnapshots(): boolean {
    return true;
  }

  async uploadSnapshot(
    state: unknown,
    clientId: string,
    reason: string,
    vectorClock: VectorClock,
    schemaVersion: number,
    isPayloadEncrypted: boolean | undefined,
    opId: string,
    isCleanSlate?: boolean,
    snapshotOpType?: string,
  ): Promise<SnapshotUploadResponse> {
    this._server.fullStateUploads.push({
      id: opId,
      clientId,
      actionType: `[fuzz] snapshot ${reason}${isCleanSlate ? ' clean-slate' : ''}`,
      opType: snapshotOpType ?? 'SYNC_IMPORT',
      entityType: 'ALL',
      payload: null,
      vectorClock,
      timestamp: Date.now(),
      schemaVersion,
      isPayloadEncrypted,
    });
    throw new FuzzUnsupportedTransportError(
      `full-state upload (${snapshotOpType ?? 'SYNC_IMPORT'}, ${reason}) from ${clientId}`,
    );
  }

  async deleteAllData(): Promise<{ success: boolean }> {
    throw new FuzzUnsupportedTransportError('deleteAllData');
  }
}
