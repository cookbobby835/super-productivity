import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { expect, test } from '../../fixtures/webdav.fixture';
import { SyncPage } from '../../pages/sync.page';
import { WorkViewPage } from '../../pages/work-view.page';
import {
  closeContextsSafely,
  createSyncFolder,
  generateSyncFolderName,
  setupSyncClient,
  waitForSyncComplete,
  WEBDAV_CONFIG_TEMPLATE,
} from '../../utils/sync-helpers';
import { waitForStatePersistence } from '../../utils/waits';

const authorization = `Basic ${Buffer.from('admin:admin').toString('base64')}`;
const root = WEBDAV_CONFIG_TEMPLATE.baseUrl;

const remoteText = async (request: APIRequestContext, url: string): Promise<string> => {
  const response = await request.get(url, { headers: { Authorization: authorization } });
  expect(response.ok(), `Expected remote file: ${url}`).toBe(true);
  return response.text();
};

const parsePrefixed = <T>(encoded: string): T =>
  JSON.parse(encoded.slice(encoded.indexOf('__') + 2)) as T;

/** Only the test starts syncs after setup, so no automatic cycle interleaves. */
const keepSyncManual = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const helpers = (
      window as unknown as {
        __e2eTestHelpers: { store: { dispatch: (action: unknown) => void } };
      }
    ).__e2eTestHelpers;
    helpers.store.dispatch({
      type: '[Global Config] Update Global Config Section',
      sectionKey: 'sync',
      sectionCfg: { isManualSyncOnly: true },
    });
  });

/**
 * A deferred upload is not a dead end: the next sync downloads the remote data
 * first and, with local data on both sides, asks. Cancelling keeps both.
 */
const expectNextSyncToAskFirst = async (page: Page, sync: SyncPage): Promise<void> => {
  await expect(sync.syncErrorIcon).toBeHidden();
  await sync.triggerSync();
  expect(await waitForSyncComplete(page, sync)).toBe('conflict');
  const dialog = page.locator('dialog-sync-conflict');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(sync.syncSpinner).toBeHidden();
};

/**
 * A synced device that moves to an empty folder seeds it with a
 * SERVER_MIGRATION SYNC_IMPORT: a snapshot-only folder (no retained ops).
 * Returns the moved-to folder's remote URL.
 */
const seedSnapshotOnlyFolder = async (
  browser: Browser,
  baseURL: string | undefined,
  request: APIRequestContext,
  seedFolder: string,
  seedTitle: string,
  isUseSplitSyncFiles: boolean,
): Promise<string> => {
  const movedFolder = `${seedFolder}-moved`;
  await createSyncFolder(request, seedFolder);
  await createSyncFolder(request, movedFolder);
  const seed = await setupSyncClient(browser, baseURL);
  try {
    const work = new WorkViewPage(seed.page);
    const sync = new SyncPage(seed.page);
    await work.waitForTaskList();
    await work.addTask(seedTitle);
    await waitForStatePersistence(seed.page);
    const config = { ...WEBDAV_CONFIG_TEMPLATE, isUseSplitSyncFiles };
    await sync.setupWebdavSync({ ...config, syncFolderPath: `/${seedFolder}` });
    await waitForSyncComplete(seed.page, sync);
    await sync.setupWebdavSync(
      { ...config, syncFolderPath: `/${movedFolder}` },
      { isReconfigure: true },
    );
    await waitForSyncComplete(seed.page, sync);
  } finally {
    await closeContextsSafely(seed.context);
  }
  return `${root}${movedFolder}/DEV/`;
};

test.describe('@webdav a late snapshot-only folder is loaded before uploading', () => {
  test.beforeEach(async ({ webdavServerUp }) => {
    void webdavServerUp;
  });

  // A fresh client's download found an empty folder. If another device seeds
  // the folder before the fresh client's upload reads it, that upload must not
  // build on data the client never loaded. With retained ops the #10256 guard
  // already defers it; a snapshot-only file has no ops to trip that guard.
  test('does not merge over a snapshot-only v2 file appearing after empty-folder discovery', async ({
    browser,
    baseURL,
    request,
  }) => {
    const seedFolder = generateSyncFolderName('late-snapshot-v2');
    const folder = `${seedFolder}-target`;
    const remote = `${root}${folder}/DEV/`;
    const seedTitle = `Seeded snapshot task ${folder}`;
    const movedRemote = await seedSnapshotOnlyFolder(
      browser,
      baseURL,
      request,
      seedFolder,
      seedTitle,
      false,
    );
    const snapshotOnly = await remoteText(request, `${movedRemote}sync-data.json`);
    const seeded = parsePrefixed<{
      version: number;
      recentOps: unknown[];
      state: unknown;
    }>(snapshotOnly);
    expect(seeded.version).toBe(2);
    expect(seeded.recentOps).toEqual([]);
    expect(JSON.stringify(seeded.state)).toContain(seedTitle);

    await createSyncFolder(request, folder);
    await createSyncFolder(request, `${folder}/DEV`);
    const joining = await setupSyncClient(browser, baseURL);
    try {
      const sync = new SyncPage(joining.page);
      const work = new WorkViewPage(joining.page);
      await work.waitForTaskList();
      const localTitle = `Pending joiner task ${folder}`;
      await work.addTask(localTitle);
      await waitForStatePersistence(joining.page);
      await keepSyncManual(joining.page);
      let legacyReads = 0;
      let published = false;
      await joining.page.route(`**/${folder}/DEV/sync-data.json`, async (route) => {
        if (route.request().method() === 'GET' && ++legacyReads === 6) {
          // Download and migration-check discovery/reads plus upload discovery
          // saw no v2. The other device's seed lands before the final upload read.
          const put = await request.put(`${remote}sync-data.json`, {
            headers: { Authorization: authorization },
            data: snapshotOnly,
          });
          expect(put.ok()).toBe(true);
          published = true;
        }
        await route.continue();
      });
      await sync.setupWebdavSync(
        { ...WEBDAV_CONFIG_TEMPLATE, syncFolderPath: `/${folder}` },
        { useProductFormatDefault: true },
      );
      await expect.poll(() => published).toBe(true);
      await expect(sync.syncSpinner).toBeHidden();

      // The seed's state is still the folder's state.
      expect(await remoteText(request, `${remote}sync-data.json`)).toBe(snapshotOnly);
      await expect(
        joining.page.locator('task').filter({ hasText: localTitle }),
      ).toBeVisible();

      await expectNextSyncToAskFirst(joining.page, sync);
      expect(await remoteText(request, `${remote}sync-data.json`)).toBe(snapshotOnly);
    } finally {
      await closeContextsSafely(joining.context);
    }
  });

  test('does not append to a snapshot-only split folder appearing after an empty download', async ({
    browser,
    baseURL,
    request,
  }) => {
    const seedFolder = generateSyncFolderName('late-snapshot-v3');
    const folder = `${seedFolder}-target`;
    const remote = `${root}${folder}/DEV/`;
    const seedTitle = `Seeded split snapshot task ${folder}`;
    const movedRemote = await seedSnapshotOnlyFolder(
      browser,
      baseURL,
      request,
      seedFolder,
      seedTitle,
      true,
    );
    const seededFiles: Record<string, string> = {};
    for (const file of ['sync-ops.json', 'sync-state.json', 'sync-data.json']) {
      seededFiles[file] = await remoteText(request, `${movedRemote}${file}`);
    }
    expect(
      parsePrefixed<{ recentOps: unknown[] }>(seededFiles['sync-ops.json']).recentOps,
    ).toEqual([]);
    expect(seededFiles['sync-state.json']).toContain(seedTitle);

    await createSyncFolder(request, folder);
    await createSyncFolder(request, `${folder}/DEV`);
    const joining = await setupSyncClient(browser, baseURL);
    try {
      const sync = new SyncPage(joining.page);
      const work = new WorkViewPage(joining.page);
      await work.waitForTaskList();
      const localTitle = `Pending split joiner task ${folder}`;
      await work.addTask(localTitle);
      await waitForStatePersistence(joining.page);
      await keepSyncManual(joining.page);
      let published = false;
      await joining.page.route(`**/${folder}/DEV/sync-data.json`, async (route) => {
        if (route.request().method() === 'GET' && !published) {
          // The joining download has just found no sync-ops.json and no
          // sync-data.json. The other device's seed lands right after.
          const response = await route.fetch();
          for (const [file, data] of Object.entries(seededFiles)) {
            const put = await request.put(`${remote}${file}`, {
              headers: { Authorization: authorization },
              data,
            });
            expect(put.ok()).toBe(true);
          }
          published = true;
          await route.fulfill({ response });
          return;
        }
        await route.continue();
      });
      await sync.setupWebdavSync({
        ...WEBDAV_CONFIG_TEMPLATE,
        syncFolderPath: `/${folder}`,
        isUseSplitSyncFiles: true,
      });
      await expect.poll(() => published).toBe(true);
      await expect(sync.syncSpinner).toBeHidden();

      // The joining client never loaded the seed's snapshot, so it must not
      // extend the seed's commit point.
      expect(await remoteText(request, `${remote}sync-ops.json`)).toBe(
        seededFiles['sync-ops.json'],
      );
      await expect(
        joining.page.locator('task').filter({ hasText: localTitle }),
      ).toBeVisible();

      await expectNextSyncToAskFirst(joining.page, sync);
      expect(await remoteText(request, `${remote}sync-ops.json`)).toBe(
        seededFiles['sync-ops.json'],
      );
    } finally {
      await closeContextsSafely(joining.context);
    }
  });
});
