import type { APIRequestContext, Request } from '@playwright/test';
import { expect, test } from '../../fixtures/webdav.fixture';
import { SyncPage } from '../../pages/sync.page';
import { WorkViewPage } from '../../pages/work-view.page';
import {
  closeContextsSafely,
  createSyncFolder,
  generateSyncFolderName,
  readPrefixedFile,
  setupSyncClient,
  waitForSyncComplete,
  WEBDAV_CONFIG_TEMPLATE,
} from '../../utils/sync-helpers';
import { waitForStatePersistence } from '../../utils/waits';

const authorization = `Basic ${Buffer.from('admin:admin').toString('base64')}`;
// Matches both the adapter notice and the sync error that carries its text.
const SPLIT_FORMAT_NOTICE = /split-file format.*(?:Enable|Turn on).*Surgical sync/i;

const remoteText = async (request: APIRequestContext, url: string): Promise<string> => {
  const response = await request.get(url, { headers: { Authorization: authorization } });
  return response.ok() ? response.text() : `HTTP ${response.status()}`;
};

test.describe('@webdav v3 snapshot creation reserves the legacy file', () => {
  test.beforeEach(async ({ webdavServerUp }) => {
    void webdavServerUp;
  });

  test('a v2 client joining while a Surgical sync client seeds a moved-to folder is not overwritten', async ({
    browser,
    baseURL,
    request,
  }) => {
    const folder = generateSyncFolderName('v3-reserve');
    const nextFolder = `${folder}-next`;
    const nextRemote = `${WEBDAV_CONFIG_TEMPLATE.baseUrl}${nextFolder}/DEV/`;
    await createSyncFolder(request, folder);
    await createSyncFolder(request, nextFolder);
    const a = await setupSyncClient(browser, baseURL);
    let b: Awaited<ReturnType<typeof setupSyncClient>> | undefined;
    try {
      const workA = new WorkViewPage(a.page);
      const syncA = new SyncPage(a.page);
      await workA.waitForTaskList();
      const aTitle = `Surgical client task ${folder}`;
      await workA.addTask(aTitle);
      await waitForStatePersistence(a.page);
      await syncA.setupWebdavSync({
        ...WEBDAV_CONFIG_TEMPLATE,
        syncFolderPath: `/${folder}`,
        isUseSplitSyncFiles: true,
      });
      await waitForSyncComplete(a.page, syncA);

      // Moving a synced device seeds the empty folder with a SERVER_MIGRATION
      // SYNC_IMPORT through the snapshot path. Uploading that snapshot is the slow
      // part of seeding, so hold its first snapshot write while another device
      // joins the same folder.
      let snapshotWriteStarted = false;
      let releaseSnapshotWrite: (() => void) | undefined;
      const snapshotWriteReleased = new Promise<void>((resolve) => {
        releaseSnapshotWrite = resolve;
      });
      await a.page.route(`**/${nextFolder}/DEV/sync-state*`, async (route) => {
        if (route.request().method() === 'PUT' && !snapshotWriteStarted) {
          snapshotWriteStarted = true;
          await snapshotWriteReleased;
        }
        await route.continue();
      });
      await syncA.setupWebdavSync(
        {
          ...WEBDAV_CONFIG_TEMPLATE,
          syncFolderPath: `/${nextFolder}`,
          isUseSplitSyncFiles: true,
        },
        { isReconfigure: true },
      );
      await expect.poll(() => snapshotWriteStarted).toBe(true);

      // A v2 device (Surgical sync saved off, as on 18.14–19.1 installs) sets up
      // the same folder meanwhile. Released v2 clients never look at
      // sync-ops.json when sync-data.json is missing.
      b = await setupSyncClient(browser, baseURL);
      const workB = new WorkViewPage(b.page);
      const syncB = new SyncPage(b.page);
      await workB.waitForTaskList();
      const bTitle = `Concurrent v2 client task ${folder}`;
      await workB.addTask(bTitle);
      await waitForStatePersistence(b.page);
      const bPuts: string[] = [];
      b.page.on('request', (req: Request) => {
        if (req.method() === 'PUT' && req.url().startsWith(nextRemote)) {
          bPuts.push(req.url());
        }
      });
      await syncB.setupWebdavSync({
        ...WEBDAV_CONFIG_TEMPLATE,
        syncFolderPath: `/${nextFolder}`,
        isUseSplitSyncFiles: false,
      });
      const bAcknowledged = await waitForSyncComplete(b.page, syncB).then(
        () => true,
        () => false,
      );
      const bSawReservation = await b.page
        .locator('snack-custom', { hasText: SPLIT_FORMAT_NOTICE })
        .isVisible();

      releaseSnapshotWrite!();
      await waitForSyncComplete(a.page, syncA);

      // An acknowledged v2 upload must survive the v3 seed. The seed has to claim
      // sync-data.json before it publishes, so a v2 client sees the tombstone
      // instead of an empty folder.
      const legacyAfter = await remoteText(request, `${nextRemote}sync-data.json`);
      const outcome = bAcknowledged
        ? legacyAfter.includes(bTitle)
          ? 'v2 upload kept'
          : 'v2 upload acknowledged, then overwritten by the v3 seed'
        : bSawReservation && bPuts.length === 0
          ? 'v2 client stopped at the reservation'
          : `v2 client failed otherwise (PUTs: ${bPuts.length})`;
      expect(outcome).toBe('v2 client stopped at the reservation');

      // The seed itself still completes, and B keeps its unsynced task.
      const ops = await readPrefixedFile<{ version: number }>(
        request,
        `${nextRemote}sync-ops.json`,
        authorization,
      );
      expect(ops.version).toBe(3);
      const tombstone = await readPrefixedFile<{ version: number; format: string }>(
        request,
        `${nextRemote}sync-data.json`,
        authorization,
      );
      expect(tombstone).toMatchObject({ version: 3, format: 'split' });
      expect(await remoteText(request, `${nextRemote}sync-state.json`)).toContain(aTitle);
      await expect(b.page.locator('task').filter({ hasText: bTitle })).toBeVisible();
    } finally {
      await closeContextsSafely(a.context, b?.context);
    }
  });
});
