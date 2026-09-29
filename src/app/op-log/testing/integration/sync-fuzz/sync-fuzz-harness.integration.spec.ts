import { TestBed } from '@angular/core/testing';
import { DEFAULT_TASK, Task } from '../../../../features/tasks/task.model';
import { WorkContextType } from '../../../../features/work-context/work-context.model';
import { addNote } from '../../../../features/note/store/note.actions';
import { TaskSharedActions } from '../../../../root-store/meta/task-shared.actions';
import { VectorClock } from '../../../core/operation.types';
import { OperationLogStoreService } from '../../../persistence/operation-log-store.service';
import { FuzzDevice, SyncFuzzHarness } from './sync-fuzz-harness';
import { comparable } from './sync-fuzz-runner';

const addTask = (
  id: string,
  title: string,
): ReturnType<typeof TaskSharedActions.addTask> =>
  TaskSharedActions.addTask({
    task: { ...DEFAULT_TASK, id, title, projectId: 'INBOX_PROJECT', created: Date.now() },
    workContextId: 'INBOX_PROJECT',
    workContextType: WorkContextType.PROJECT,
    isAddToBacklog: false,
    isAddToBottom: false,
  });

const taskTitle = async (
  harness: SyncFuzzHarness,
  device: FuzzDevice,
  id: string,
): Promise<string | undefined> =>
  harness.as(device, async () => {
    const tasks = (await harness.state())['tasks'] as { entities: Record<string, Task> };
    return tasks.entities[id]?.title;
  });

describe('SyncFuzzHarness: two devices on one injector', () => {
  let harness: SyncFuzzHarness;
  let a: FuzzDevice;
  let b: FuzzDevice;

  beforeEach(async () => {
    harness = await SyncFuzzHarness.create();
    a = await harness.addDevice('A');
    b = await harness.addDevice('B');
  });

  afterEach(() => SyncFuzzHarness.dispose());

  it('keeps each device’s store, op log, clock and cursor apart', async () => {
    await harness.as(a, async () => {
      await harness.dispatch(addTask('t1', 'from A'));
      await harness.dispatch(
        addNote({
          note: {
            id: 'n1',
            projectId: 'INBOX_PROJECT',
            isPinnedToToday: false,
            content: 'note A',
            created: Date.now(),
            modified: Date.now(),
          },
        }),
      );
    });
    expect(await taskTitle(harness, a, 't1')).toBe('from A');
    expect(await taskTitle(harness, b, 't1')).toBeUndefined();
    expect(await harness.pendingOpCount(a)).toBe(2);
    expect(await harness.pendingOpCount(b)).toBe(0);

    expect(await harness.sync(a)).toBe(true);
    expect(harness.server.rows.length).toBe(2);
    expect(await harness.sync(b)).toBe(true);
    expect(await taskTitle(harness, b, 't1')).toBe('from A');
    expect(await harness.pendingOpCount(b)).toBe(0);

    await harness.as(b, () =>
      harness.dispatch(
        TaskSharedActions.updateTask({
          task: { id: 't1', changes: { title: 'from B' } },
        }),
      ),
    );
    expect(await taskTitle(harness, a, 't1')).toBe('from A');
    expect(await harness.sync(b)).toBe(true);
    expect(await harness.sync(a)).toBe(true);
    expect(await taskTitle(harness, a, 't1')).toBe('from B');

    const clocks: (VectorClock | null)[] = [];
    for (const device of [a, b]) {
      clocks.push(
        await harness.as(device, () =>
          TestBed.inject(OperationLogStoreService).getVectorClock(),
        ),
      );
    }
    expect(clocks[0]).toEqual({ fuzzDevA: 2, fuzzDevB: 1 });
    expect(clocks[1]).toEqual({ fuzzDevA: 2, fuzzDevB: 1 });
    expect(await a.client.getLastServerSeq()).toBe(3);
    expect(await b.client.getLastServerSeq()).toBe(3);
    expect(comparable(await harness.syncedState(a))).toEqual(
      comparable(await harness.syncedState(b)),
    );
    expect(harness.events).toEqual([]);
  });

  it('detects a leak between devices when isolation is bypassed', async () => {
    // Guard against a vacuous pass: the same comparison must fail when B never syncs.
    await harness.as(a, () => harness.dispatch(addTask('t1', 'only A')));
    expect(comparable(await harness.syncedState(a))).not.toEqual(
      comparable(await harness.syncedState(b)),
    );
  });
});
