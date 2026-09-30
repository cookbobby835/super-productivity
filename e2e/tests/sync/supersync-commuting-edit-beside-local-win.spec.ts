import type { Browser } from '@playwright/test';
import { test, expect } from '../../fixtures/supersync.fixture';
import {
  createTestUser,
  getSuperSyncConfig,
  createSimulatedClient,
  closeClient,
  waitForTask,
  markTaskDone,
  recordTaskTimeDelta,
  type SimulatedE2EClient,
} from '../../utils/supersync-helpers';

/**
 * Since #10252 (unreleased), a remote edit that touches other fields than a
 * pending task time delta commutes with it (`isCommutingTimeDeltaCrossing`)
 * and is applied without a conflict.
 *
 * Here one download brings two remote ops for the same task: a notes edit
 * that commutes with the pending ops, and a done toggle that conflicts with
 * the local one and loses by LWW. The local side builds its whole-task
 * `[TASK] LWW Update` from the state before the notes edit is applied, then
 * applies the notes edit. B keeps A's notes, but the replace-mode snapshot it
 * uploads has none, and A drops its own notes.
 *
 * Before the fix, A's notes were gone on A only (#10385). The local-win
 * snapshot now carries the readable fields of the same batch's nonconflicting
 * ops (`buildTimeAwareResolutionBatches`). The second test is the other
 * conflict direction: A's done toggle is the later one, so B's loses. The sync
 * fuzz harness pins the same trace (sync-fuzz-pinned-traces.json, class
 * commuting-edit-beside-local-win).
 */

/** Only explicit syncs run, so every crossing happens in the stated order. */
const blockBackgroundSync = async (client: SimulatedE2EClient): Promise<void> => {
  await client.page.evaluate(() => {
    const flags = globalThis as typeof globalThis & Record<string, boolean>;
    flags['__SP_E2E_BLOCK_AUTO_SYNC'] = true;
    flags['__SP_E2E_BLOCK_WS_DOWNLOAD'] = true;
    flags['__SP_E2E_BLOCK_IMMEDIATE_UPLOAD'] = true;
  });
};

/** Fail on the dataset conflict dialog or an error instead of resolving it. */
const sync = async (client: SimulatedE2EClient): Promise<void> => {
  const downloaded = client.page.waitForResponse(
    (response) =>
      response.url().includes('/api/sync/ops') && response.request().method() === 'GET',
  );
  await client.sync.clickSyncBtn();
  expect((await downloaded).ok()).toBe(true);
  const outcome = async (): Promise<string> => {
    if (await client.sync.conflictDialog.isVisible()) return 'conflict-dialog';
    if (await client.sync.hasSyncError()) return 'error';
    const spinning = await client.sync.syncSpinner.isVisible();
    const checked = await client.sync.syncCheckIcon
      .filter({ hasText: /^done_all$/ })
      .isVisible();
    return !spinning && checked ? 'in-sync' : 'pending';
  };
  let observed = 'pending';
  await expect
    .poll(
      async () => {
        observed = await outcome();
        return observed;
      },
      { timeout: 30000 },
    )
    .not.toBe('pending');
  expect(observed).toBe('in-sync');
};

/**
 * Sets the task's notes through the store with the action the notes editor
 * dispatches (`TaskService.update`), or only reads; returns what the device
 * holds afterwards.
 */
const onTask = async (
  client: SimulatedE2EClient,
  taskName: string,
  notes?: string,
): Promise<{ notes: string | null; isDone: boolean; timeSpent: number }> =>
  client.page.evaluate(
    async ({ name, newNotes }) => {
      type Subscription = { unsubscribe: () => void };
      type StoreLike = {
        subscribe: (next: (state: unknown) => void) => Subscription;
        dispatch: (action: unknown) => void;
      };
      const store = (window as unknown as { __e2eTestHelpers?: { store?: StoreLike } })
        .__e2eTestHelpers?.store;
      if (!store) {
        throw new Error('E2E store helper is unavailable');
      }
      const readTask = (): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          const ref: { current?: Subscription } = {};
          ref.current = store.subscribe((state) => {
            window.setTimeout(() => ref.current?.unsubscribe());
            const root = state as Record<string, { entities?: Record<string, unknown> }>;
            const entities = (root.tasks ?? root.task)?.entities ?? {};
            const task = Object.values(entities).find(
              (value) =>
                typeof value === 'object' &&
                value !== null &&
                String((value as Record<string, unknown>).title).includes(name),
            );
            if (task) {
              resolve(task as Record<string, unknown>);
            } else {
              reject(new Error(`Task not found: ${name}`));
            }
          });
        });
      if (newNotes !== undefined) {
        const task = await readTask();
        store.dispatch({
          type: '[Task Shared] updateTask',
          task: { id: task.id, changes: { notes: newNotes } },
          meta: {
            isPersistent: true,
            entityType: 'TASK',
            entityId: task.id,
            opType: 'UPD',
          },
        });
      }
      const current = await readTask();
      return {
        notes: typeof current.notes === 'string' ? current.notes : null,
        isDone: current.isDone === true,
        timeSpent: typeof current.timeSpent === 'number' ? current.timeSpent : 0,
      };
    },
    { name: taskName, newNotes: notes },
  );

test.describe('@supersync remote edit beside a local LWW win', () => {
  /**
   * A writes notes and a done toggle and uploads them one by one; B, not
   * synced since the task arrived, tracks time (a pending delta) and marks the
   * task done. `bWins` decides whose done toggle is later and so wins LWW.
   */
  const runCrossing = async (
    {
      browser,
      baseURL,
      testRunId,
    }: { browser: Browser; baseURL?: string; testRunId: string },
    bWins: boolean,
  ): Promise<void> => {
    const taskName = `NotesBesideLocalWin-${Date.now()}`;
    const notes = 'Notes written on A';
    const trackedOnB = 60000;
    const clients: SimulatedE2EClient[] = [];

    try {
      const syncConfig = getSuperSyncConfig(await createTestUser(testRunId));
      const clientA = await createSimulatedClient(browser, baseURL!, 'A', testRunId);
      clients.push(clientA);
      await clientA.sync.setupSuperSync(syncConfig);
      await clientA.workView.addTask(taskName);
      await waitForTask(clientA.page, taskName);
      await clientA.sync.syncAndWait();

      const clientB = await createSimulatedClient(browser, baseURL!, 'B', testRunId);
      clients.push(clientB);
      await clientB.sync.setupSuperSync(syncConfig);
      await clientB.sync.syncAndWait();
      await waitForTask(clientB.page, taskName);

      for (const client of clients) {
        await blockBackgroundSync(client);
      }

      const trackAndMarkDoneOnB = async (): Promise<void> => {
        await recordTaskTimeDelta(clientB, taskName, '2026-07-13', trackedOnB);
        await markTaskDone(clientB, taskName);
        expect(await onTask(clientB, taskName)).toEqual({
          notes: null,
          isDone: true,
          timeSpent: trackedOnB,
        });
      };

      // B's done toggle is the earlier one when A should win.
      if (!bWins) {
        await trackAndMarkDoneOnB();
      }

      // A uploads its notes edit, then its done toggle: B downloads both at once.
      expect(await onTask(clientA, taskName, notes)).toEqual({
        notes,
        isDone: false,
        timeSpent: 0,
      });
      await sync(clientA);
      await markTaskDone(clientA, taskName);
      await sync(clientA);

      if (bWins) {
        await trackAndMarkDoneOnB();
      }

      await sync(clientB);
      await sync(clientA);
      await sync(clientB);

      // Both devices, in one assertion, so a failure shows the divergence.
      // When B loses, it rejects every pending op of the task, its time delta
      // included, which then never uploads (#10260, also on master before
      // this fix); only the fields this fix covers are compared then.
      const view = async (
        client: SimulatedE2EClient,
      ): Promise<Partial<Awaited<ReturnType<typeof onTask>>>> => {
        const task = await onTask(client, taskName);
        return bWins ? task : { notes: task.notes, isDone: task.isDone };
      };
      const expected = bWins
        ? { notes, isDone: true, timeSpent: trackedOnB }
        : { notes, isDone: true };
      await expect
        .poll(async () => ({ A: await view(clientA), B: await view(clientB) }), {
          timeout: 30000,
        })
        .toEqual({ A: expected, B: expected });
    } finally {
      for (const client of clients) {
        await closeClient(client);
      }
    }
  };

  test('a notes edit that commutes with a pending time delta survives a same-batch local win', async ({
    browser,
    baseURL,
    testRunId,
  }) => {
    test.setTimeout(240000);
    await runCrossing({ browser, baseURL, testRunId }, true);
  });

  test('a notes edit that commutes with a pending time delta survives a same-batch remote win', async ({
    browser,
    baseURL,
    testRunId,
  }) => {
    test.setTimeout(240000);
    await runCrossing({ browser, baseURL, testRunId }, false);
  });
});
