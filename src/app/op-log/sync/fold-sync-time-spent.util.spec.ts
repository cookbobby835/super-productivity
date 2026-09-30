import {
  buildTimeAwareResolutionBatches,
  foldSyncTimeSpentDeltas,
} from './fold-sync-time-spent.util';
import { ActionType, EntityType, OpType, Operation } from '../core/operation.types';

const DAY = '2026-07-10';
const PREV_DAY = '2026-07-09';
const NEXT_DAY = '2026-07-11';

const deltaOp = (actionPayload: Record<string, unknown>): Operation => ({
  id: 'op-delta',
  actionType: ActionType.TIME_TRACKING_SYNC_TIME_SPENT,
  opType: OpType.Update,
  entityType: 'TASK' as EntityType,
  entityId: 'task-1',
  payload: { actionPayload, entityChanges: [] },
  clientId: 'B',
  vectorClock: { B: 1 },
  timestamp: 1000,
  schemaVersion: 1,
});

describe('foldSyncTimeSpentDeltas', () => {
  const changes = { timeSpent: 900, timeSpentOnDay: { [DAY]: 600, [PREV_DAY]: 300 } };

  it('adds the delta to its day and recomputes timeSpent', () => {
    expect(
      foldSyncTimeSpentDeltas('task-1', changes, [
        deltaOp({ taskId: 'task-1', date: DAY, duration: 50 }),
        deltaOp({ taskId: 'task-1', date: NEXT_DAY, duration: 7 }),
      ]),
    ).toEqual({
      timeSpent: 957,
      timeSpentOnDay: { [DAY]: 650, [PREV_DAY]: 300, [NEXT_DAY]: 7 },
    });
  });

  it('ignores deltas for other tasks, other action types and malformed payloads', () => {
    const otherAction = {
      ...deltaOp({ taskId: 'task-1', date: DAY, duration: 50 }),
      actionType: '[Task] Update' as ActionType,
    };
    const ops = [
      deltaOp({ taskId: 'task-2', date: DAY, duration: 50 }),
      deltaOp({ taskId: 'task-1', date: DAY, duration: Number.NaN }),
      { ...deltaOp({}), payload: null },
      otherAction,
    ];

    expect(foldSyncTimeSpentDeltas('task-1', changes, ops)).toBe(changes);
  });

  it('leaves a projection without timeSpentOnDay untouched', () => {
    const titleOnly = { title: 'x' };
    expect(
      foldSyncTimeSpentDeltas('task-1', titleOnly, [
        deltaOp({ taskId: 'task-1', date: DAY, duration: 50 }),
      ]),
    ).toBe(titleOnly);
  });

  it('includes child deltas in a parent projection without emitting relationship fields', () => {
    expect(
      foldSyncTimeSpentDeltas(
        'parent',
        changes,
        [
          deltaOp({ taskId: 'child', date: DAY, duration: 50 }),
          deltaOp({ taskId: 'other-task', date: DAY, duration: 100 }),
        ],
        ['child'],
      ),
    ).toEqual({
      timeSpent: 950,
      timeSpentOnDay: { [DAY]: 650, [PREV_DAY]: 300 },
    });
  });

  // The reducer adds a child's delta to the parent's stored timeSpent; the fold
  // recomputes it from timeSpentOnDay. On a drifted parent the two differ, but
  // every device applies the same folded snapshot, so they still converge.
  it('recomputes a drifted parent timeSpent from timeSpentOnDay', () => {
    const drifted = { ...changes, timeSpent: 1234 };
    expect(
      foldSyncTimeSpentDeltas(
        'parent',
        drifted,
        [deltaOp({ taskId: 'child', date: DAY, duration: 50 })],
        ['child'],
      ),
    ).toEqual({
      timeSpent: 950,
      timeSpentOnDay: { [DAY]: 650, [PREV_DAY]: 300 },
    });
  });
});

describe('buildTimeAwareResolutionBatches: readable fields of nonconflicting ops', () => {
  const localWin = (
    lwwUpdateMode: 'replace' | 'patch' = 'replace',
    actionPayload: Record<string, unknown> = { id: 'task-1', title: 'T', isDone: true },
  ): Operation => ({
    id: 'op-local-win',
    actionType: '[TASK] LWW Update' as ActionType,
    opType: OpType.Update,
    entityType: 'TASK' as EntityType,
    entityId: 'task-1',
    payload: { actionPayload, entityChanges: [], lwwUpdateMode },
    clientId: 'B',
    vectorClock: { A: 2, B: 3 },
    timestamp: 3000,
    schemaVersion: 1,
  });
  const taskUpdate = (
    id: string,
    changes: Record<string, unknown>,
    extra: Partial<Operation> & { clearedFields?: string[] } = {},
  ): Operation => {
    const { clearedFields, ...opExtra } = extra;
    return {
      id,
      actionType: ActionType.TASK_SHARED_UPDATE,
      opType: OpType.Update,
      entityType: 'TASK' as EntityType,
      entityId: 'task-1',
      payload: {
        actionPayload: {
          task: { id: opExtra.entityId ?? 'task-1', changes },
          ...(clearedFields ? { clearedFields } : {}),
        },
        entityChanges: [],
      },
      clientId: 'A',
      vectorClock: { A: 1 },
      timestamp: 1000,
      schemaVersion: 1,
      ...opExtra,
    };
  };
  const build = (
    newLocalWinOps: Operation[],
    nonConflictingOps: Operation[],
    remoteWinsOps: Operation[] = [],
  ): ReturnType<typeof buildTimeAwareResolutionBatches> =>
    buildTimeAwareResolutionBatches({
      unappliedRemoteLosers: [],
      compensatedRemoteOps: [],
      newLocalWinOps,
      remoteWinsOps,
      localMultiReconciliationOps: [],
      nonConflictingOps,
      getTask: async () => undefined,
    });
  const localBatchOps = (
    batches: Awaited<ReturnType<typeof build>>['batches'],
  ): readonly Operation[] => batches.find((batch) => batch.source === 'local')!.ops;

  // #10385: a notes edit that commutes with a pending time delta arrives in
  // the same download as a done toggle this device wins.
  it('overlays the edit onto a replace snapshot and persists it before the snapshot', async () => {
    const notesEdit = taskUpdate(
      'op-notes',
      { notes: 'from A' },
      { vectorClock: { A: 4 } },
    );
    const { batches, precedingOps } = await build([localWin()], [notesEdit]);

    expect(precedingOps).toEqual([notesEdit]);
    expect(batches.map((batch) => batch.source)).toEqual(['remote', 'local']);
    expect(batches[0].ops).toEqual([notesEdit]);
    const [snapshot] = localBatchOps(batches);
    expect((snapshot.payload as { actionPayload: unknown }).actionPayload).toEqual({
      id: 'task-1',
      title: 'T',
      isDone: true,
      notes: 'from A',
    });
    expect(snapshot.vectorClock).toEqual({ A: 4, B: 3 });
  });

  it('carries a clear, and lets the later of two edits win a field', async () => {
    const first = taskUpdate('op-1', { notes: 'first', title: 'renamed' });
    const clear = taskUpdate('op-2', {}, { clearedFields: ['notes'] });
    const { batches } = await build([localWin()], [first, clear]);

    const actionPayload = (
      localBatchOps(batches)[0].payload as {
        actionPayload: Record<string, unknown>;
      }
    ).actionPayload;
    expect(actionPayload['title']).toBe('renamed');
    expect('notes' in actionPayload).toBeTrue();
    expect(actionPayload['notes']).toBeUndefined();
  });

  it('leaves the snapshot alone for ops that are not plain field edits of this task', async () => {
    const snapshot = localWin();
    const ignored = [
      taskUpdate('op-other-task', { notes: 'x' }, { entityId: 'task-2' }),
      taskUpdate('op-multi', { notes: 'x' }, { entityIds: ['task-1', 'task-2'] }),
      taskUpdate('op-opaque', {}),
      taskUpdate('op-time-only', { timeSpentOnDay: { [DAY]: 1 }, timeSpent: 1 }),
      // `isDone` also sets `doneOn` in the reducer; an overlay cannot.
      taskUpdate('op-reopen', { isDone: false }),
      taskUpdate('op-notes-and-done', { notes: 'x', isDone: false }),
      { ...localWin(), id: 'op-remote-lww', clientId: 'A' },
      // A delta's arguments are not task fields (#10147), although capture
      // records them as its entity change.
      {
        ...deltaOp({ taskId: 'task-1', date: DAY, duration: 50 }),
        payload: {
          actionPayload: { taskId: 'task-1', date: DAY, duration: 50 },
          entityChanges: [
            {
              entityType: 'TASK' as EntityType,
              entityId: 'task-1',
              opType: OpType.Update,
              changes: { taskId: 'task-1', date: DAY, duration: 50 },
            },
          ],
        },
      },
    ];
    const { batches, precedingOps } = await build([snapshot], ignored);

    expect(precedingOps).toEqual([]);
    expect(localBatchOps(batches)).toEqual([snapshot]);
  });

  // The remote winner is applied after the snapshot, so a folded field could
  // differ from this device's post-batch value.
  it('leaves the snapshot alone when a remote winner of the task follows it', async () => {
    const snapshot = localWin();
    const remoteWinner = { ...localWin(), id: 'op-remote-winner', clientId: 'C' };
    const { batches, precedingOps } = await build(
      [snapshot],
      [taskUpdate('op-rename', { title: 'older' })],
      [remoteWinner],
    );

    expect(precedingOps).toEqual([]);
    expect(localBatchOps(batches)).toEqual([snapshot]);
  });

  it('leaves a patch snapshot alone: it does not erase fields it does not carry', async () => {
    const patch = localWin('patch', { isDone: true });
    const { batches, precedingOps } = await build(
      [patch],
      [taskUpdate('op-notes', { notes: 'from A' })],
    );

    expect(precedingOps).toEqual([]);
    expect(localBatchOps(batches)).toEqual([patch]);
  });
});
