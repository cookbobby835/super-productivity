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
 * #10408: B tracks time on a task (a pending `syncTimeSpent` delta) and marks
 * it done; A marks the same task done and syncs first. The two done toggles
 * conflict. When A's is later, the remote side wins and B used to reject
 * every pending op of the task, the delta included, so B's tracked time never
 * reached A. A delta commutes with a winner that writes no time field, so
 * both devices must end with B's time, in either conflict direction.
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

/** What the device holds for the task. */
const readTask = async (
  client: SimulatedE2EClient,
  taskName: string,
): Promise<{ isDone: boolean; timeSpent: number }> =>
  client.page.evaluate(async (name) => {
    type Subscription = { unsubscribe: () => void };
    type StoreLike = { subscribe: (next: (state: unknown) => void) => Subscription };
    const store = (window as unknown as { __e2eTestHelpers?: { store?: StoreLike } })
      .__e2eTestHelpers?.store;
    if (!store) {
      throw new Error('E2E store helper is unavailable');
    }
    const task = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ref: { current?: Subscription } = {};
      ref.current = store.subscribe((state) => {
        window.setTimeout(() => ref.current?.unsubscribe());
        const root = state as Record<string, { entities?: Record<string, unknown> }>;
        const entities = (root.tasks ?? root.task)?.entities ?? {};
        const found = Object.values(entities).find(
          (value) =>
            typeof value === 'object' &&
            value !== null &&
            String((value as Record<string, unknown>).title).includes(name),
        );
        if (found) {
          resolve(found as Record<string, unknown>);
        } else {
          reject(new Error(`Task not found: ${name}`));
        }
      });
    });
    return {
      isDone: task.isDone === true,
      timeSpent: typeof task.timeSpent === 'number' ? task.timeSpent : 0,
    };
  }, taskName);

test.describe('@supersync tracked time beside a conflicting edit', () => {
  /** `aWins`: A's done toggle is the later one, so B's side loses. */
  const runCrossing = async (
    {
      browser,
      baseURL,
      testRunId,
    }: { browser: Browser; baseURL?: string; testRunId: string },
    aWins: boolean,
  ): Promise<void> => {
    const taskName = `TimeBesideRemoteWin-${Date.now()}`;
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

      const markDoneOnA = async (): Promise<void> => {
        await markTaskDone(clientA, taskName);
        await sync(clientA);
      };

      // The later done toggle wins LWW.
      if (!aWins) {
        await markDoneOnA();
      }
      await recordTaskTimeDelta(clientB, taskName, '2026-07-13', trackedOnB);
      await markTaskDone(clientB, taskName);
      expect(await readTask(clientB, taskName)).toEqual({
        isDone: true,
        timeSpent: trackedOnB,
      });
      if (aWins) {
        await markDoneOnA();
      }

      await sync(clientB);
      await sync(clientA);
      await sync(clientB);

      // Both devices, in one assertion, so a failure shows the divergence.
      const expected = { isDone: true, timeSpent: trackedOnB };
      await expect
        .poll(
          async () => ({
            A: await readTask(clientA, taskName),
            B: await readTask(clientB, taskName),
          }),
          { timeout: 30000 },
        )
        .toEqual({ A: expected, B: expected });
    } finally {
      for (const client of clients) {
        await closeClient(client);
      }
    }
  };

  test('tracked time survives when the other device wins the conflict', async ({
    browser,
    baseURL,
    testRunId,
  }) => {
    test.setTimeout(240000);
    await runCrossing({ browser, baseURL, testRunId }, true);
  });

  test('tracked time survives when the tracking device wins the conflict', async ({
    browser,
    baseURL,
    testRunId,
  }) => {
    test.setTimeout(240000);
    await runCrossing({ browser, baseURL, testRunId }, false);
  });
});
