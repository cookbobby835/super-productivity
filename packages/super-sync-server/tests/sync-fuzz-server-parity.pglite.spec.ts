import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import {
  detectConflict,
  getConflictEntityIds,
  getStoredEntityIds,
  isSameDuplicateOperation,
  isSameIncomingOperation,
  resolveConflictForExistingOp,
} from '../src/sync/conflict';
import {
  DEFAULT_SYNC_CONFIG,
  limitVectorClockSize,
  SYNC_ERROR_CODES,
  type Operation,
  type VectorClock,
} from '../src/sync/sync.types';
import * as port from '../../../src/app/op-log/testing/integration/sync-fuzz/fake-super-sync-server';

/**
 * Parity for the in-memory SuperSync port the app's sync fuzz harness runs
 * against (src/app/op-log/testing/integration/sync-fuzz/). Seeded random
 * operations go through the real conflict functions (detectConflict on PGlite,
 * with the production SQL) and through the port; every verdict must match.
 * A server change that alters conflict, duplicate or entity-id rules fails
 * here until the port follows.
 */

const USER_ID = 1;
const DELTA = '[TimeTracking] Sync time spent';
const CLIENTS = ['cA', 'cB', 'cC', 'cD'];
const ENTITY_IDS = ['e1', 'e2', 'e3', 'tasks', 'misc'];

const createRandom = (seed: number): (() => number) => {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const randomOp = (random: () => number, id: string): Operation => {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const clock: VectorClock = {};
  for (const client of CLIENTS) {
    if (random() < 0.6) clock[client] = 1 + Math.floor(random() * 3);
  }
  const clientId = pick(CLIENTS);
  clock[clientId] = clock[clientId] ?? 1;
  const multi = random() < 0.25;
  const entityType = random() < 0.2 ? 'GLOBAL_CONFIG' : pick(['TASK', 'NOTE']);
  const entityId = pick(ENTITY_IDS);
  const opType = random() < 0.05 ? 'SYNC_IMPORT' : pick(['UPD', 'CRT', 'DEL', 'MOV']);
  return {
    id,
    clientId,
    actionType: random() < 0.3 ? DELTA : pick(['[Task] Update', '[Note] Update Note']),
    opType: opType as Operation['opType'],
    entityType,
    entityId,
    ...(multi
      ? { entityIds: [pick(ENTITY_IDS), pick(ENTITY_IDS), pick(ENTITY_IDS)] }
      : {}),
    payload: { v: Math.floor(random() * 3) },
    vectorClock: clock,
    timestamp: 1_000 + Math.floor(random() * 3),
    schemaVersion: random() < 0.2 ? 1 : 2,
  };
};

/** Renders the Prisma calls conflict.ts makes as SQL on PGlite. */
const createTransaction = (db: PGlite): Prisma.TransactionClient => {
  const columns: Record<string, string> = {
    actionType: 'action_type AS "actionType"',
    clientId: 'client_id AS "clientId"',
    vectorClock: 'vector_clock AS "vectorClock"',
    serverSeq: 'server_seq AS "serverSeq"',
  };
  const selectSql = (select: Record<string, boolean>): string =>
    Object.keys(select)
      .filter((key) => select[key])
      .map((key) => {
        if (!columns[key]) throw new Error(`no column for select key ${key}`);
        return columns[key];
      })
      .join(', ');
  interface Where {
    userId: number;
    entityType: string;
    entityId: string;
    schemaVersion?: { lt: number };
  }
  const tx = {
    operation: {
      findFirst: async (args: { where: Where; select: Record<string, boolean> }) => {
        const { userId, entityType, entityId, schemaVersion } = args.where;
        const rows = await db.query<Record<string, unknown>>(
          `SELECT ${selectSql(args.select)} FROM operations
             WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3
             ${schemaVersion ? 'AND schema_version < $4' : ''}
             ORDER BY server_seq DESC LIMIT 1`,
          schemaVersion
            ? [userId, entityType, entityId, schemaVersion.lt]
            : [userId, entityType, entityId],
        );
        return rows.rows[0] ?? null;
      },
      findUnique: async (args: {
        where: { userId_serverSeq: { userId: number; serverSeq: number } };
        select: Record<string, boolean>;
      }) => {
        const { userId, serverSeq } = args.where.userId_serverSeq;
        const rows = await db.query<Record<string, unknown>>(
          `SELECT ${selectSql(args.select)} FROM operations
             WHERE user_id = $1 AND server_seq = $2`,
          [userId, serverSeq],
        );
        return rows.rows[0] ?? null;
      },
    },
    $queryRaw: async (
      strings: TemplateStringsArray,
      ...values: Array<Prisma.Sql | Prisma.Sql['values'][number]>
    ) => {
      const query = Prisma.sql(strings, ...values);
      return (await db.query(query.text, query.values)).rows;
    },
  };
  return tx as unknown as Prisma.TransactionClient;
};

describe('sync fuzz SuperSync port: parity with the real server rules', () => {
  let db: PGlite;
  let tx: Prisma.TransactionClient;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    tx = createTransaction(db);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.exec(`
      DROP TABLE IF EXISTS operations;
      CREATE TABLE operations (
        id text PRIMARY KEY,
        user_id integer NOT NULL,
        client_id text NOT NULL,
        server_seq integer NOT NULL,
        action_type text NOT NULL,
        entity_type text NOT NULL,
        entity_id text,
        entity_ids text[] NOT NULL DEFAULT '{}',
        vector_clock jsonb NOT NULL,
        schema_version integer NOT NULL
      );
      CREATE INDEX operations_entity_ids_gin ON operations USING GIN (entity_ids);
    `);
  });

  /** Persists `op` as the server stores an accepted op, in PGlite and the port. */
  const store = async (
    server: port.FakeSuperSyncServer,
    op: Operation,
    serverSeq: number,
  ): Promise<void> => {
    const stored = {
      ...op,
      vectorClock: limitVectorClockSize(op.vectorClock, [op.clientId]),
      entityIds: getStoredEntityIds(op),
    };
    await db.query(
      `INSERT INTO operations (id, user_id, client_id, server_seq, action_type,
         entity_type, entity_id, entity_ids, vector_clock, schema_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        op.id,
        USER_ID,
        op.clientId,
        serverSeq,
        op.actionType,
        op.entityType,
        op.entityId ?? null,
        stored.entityIds,
        JSON.stringify(stored.vectorClock),
        op.schemaVersion,
      ],
    );
    server.rows.push({
      serverSeq,
      receivedAt: 5_000,
      clientTimestamp: op.timestamp,
      op: stored,
    });
  };

  it('agrees on the pre-v2 GLOBAL_CONFIG misc alias for tasks settings', async () => {
    const server = new port.FakeSuperSyncServer(() => 5_000);
    const config = (
      id: string,
      entityId: string,
      clock: VectorClock,
      v: number,
    ): Operation => ({
      id,
      clientId: Object.keys(clock)[0],
      actionType: '[Global Config] Update Global Config Section',
      opType: 'UPD',
      entityType: 'GLOBAL_CONFIG',
      entityId,
      payload: {},
      vectorClock: clock,
      timestamp: 1_000,
      schemaVersion: v,
    });
    await store(server, config('tasks-v2', 'tasks', { cA: 1 }, 2), 1);
    await store(server, config('misc-v1', 'misc', { cB: 1 }, 1), 2);
    // Concurrent only with the newer legacy misc row, which the alias consults.
    const incoming = config('tasks-next', 'tasks', { cA: 2 }, 2);
    const real = await detectConflict(USER_ID, incoming, tx);
    expect(real.hasConflict).toBe(true);
    expect(server.detectConflict(incoming)).toEqual(real);
  });

  for (let seed = 1; seed <= 12; seed++) {
    it(`detectConflict agrees on random histories (seed ${seed})`, async () => {
      const random = createRandom(seed);
      const server = new port.FakeSuperSyncServer(() => 5_000);
      for (let i = 0; i < 60; i++) {
        const op = randomOp(random, `op-${seed}-${i}`);
        const real = await detectConflict(USER_ID, op, tx);
        const ported = server.detectConflict(op);
        expect(ported, `op ${i}: ${JSON.stringify(op)}`).toEqual(real);

        // Store it either way, as the server would store an accepted op.
        await store(server, op, i + 1);
      }
    });
  }

  it('pure helpers agree on random operations', () => {
    const random = createRandom(99);
    // A retry of `op` with at most one field changed, or an unrelated op, so
    // every identity field of the duplicate checks is exercised on its own.
    const variantOf = (op: Operation, id: string): Operation => {
      const other = randomOp(random, id);
      const roll = random();
      if (roll < 0.3) return { ...op };
      if (roll < 0.4) return { ...op, vectorClock: other.vectorClock };
      if (roll < 0.5) return { ...op, payload: other.payload };
      if (roll < 0.6) return { ...op, entityIds: other.entityIds };
      if (roll < 0.7) return { ...op, timestamp: op.timestamp + 1 };
      if (roll < 0.8) return { ...op, schemaVersion: other.schemaVersion };
      return other;
    };
    for (let i = 0; i < 600; i++) {
      const op = randomOp(random, `p-${i}`);
      const other = variantOf(op, `p-${i}`);
      const existing = randomOp(random, `x-${i}`);
      expect(port.getConflictEntityIds(op)).toEqual(getConflictEntityIds(op));
      expect(port.getStoredEntityIds(op)).toEqual(getStoredEntityIds(op));
      expect(port.resolveConflictForExistingOp(op, 'e1', existing)).toEqual(
        resolveConflictForExistingOp(op, 'e1', existing),
      );
      expect(port.isSameIncomingOperation(op, other)).toBe(
        isSameIncomingOperation(op, other),
      );
      const storedClock = limitVectorClockSize(other.vectorClock, [other.clientId]);
      const receivedAt =
        5_000 - (random() < 0.3 ? DEFAULT_SYNC_CONFIG.maxClockDriftMs : 0);
      expect(
        port.isSameDuplicateOperation(
          {
            serverSeq: 1,
            receivedAt,
            clientTimestamp: other.timestamp,
            op: {
              ...other,
              vectorClock: storedClock,
              entityIds: getStoredEntityIds(other),
              isPayloadEncrypted: false,
            },
          },
          op,
          DEFAULT_SYNC_CONFIG.maxClockDriftMs,
        ),
      ).toBe(
        isSameDuplicateOperation(
          {
            id: other.id,
            userId: USER_ID,
            clientId: other.clientId,
            actionType: other.actionType,
            opType: other.opType,
            entityType: other.entityType,
            entityId: other.entityId ?? null,
            entityIds: getStoredEntityIds(other),
            payload: other.payload,
            vectorClock: storedClock,
            schemaVersion: other.schemaVersion,
            clientTimestamp: other.timestamp,
            receivedAt,
            isPayloadEncrypted: false,
            syncImportReason: null,
            repairBaseServerSeq: null,
          },
          USER_ID,
          op,
          DEFAULT_SYNC_CONFIG.maxClockDriftMs,
        ),
      );
    }
  });

  it('uses the server error codes and clock-drift window', () => {
    for (const code of [
      'CONFLICT_CONCURRENT',
      'CONFLICT_SUPERSEDED',
      'DUPLICATE_OPERATION',
      'INVALID_OP_ID',
      'INTERNAL_ERROR',
    ]) {
      expect(SYNC_ERROR_CODES).toHaveProperty(code, code);
    }
    expect(DEFAULT_SYNC_CONFIG.maxClockDriftMs).toBe(60_000);
    expect(port.STATE_REPLACEMENT_REQUIRED_ERROR).toBeTruthy();
  });
});
