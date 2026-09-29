import type { APIRequestContext } from '@playwright/test';
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
import { waitForAppReady, waitForStatePersistence } from '../../utils/waits';

const authorization = `Basic ${Buffer.from('admin:admin').toString('base64')}`;

const remoteStatus = async (request: APIRequestContext, url: string): Promise<number> =>
  (await request.get(url, { headers: { Authorization: authorization } })).status();

test.describe('@webdav an interrupted v2 write keeps the folder on v2', () => {
  test.beforeEach(async ({ webdavServerUp }) => {
    void webdavServerUp;
  });

  // Existing v2 folders are never migrated automatically. A v2 folder whose
  // primary write was killed must not look like an empty folder to a device
  // that already synced it: the empty-folder format could otherwise turn it
  // into v3 and lock the v2 devices out.
  test('a default client re-seeds a v2 folder with a missing primary as v2', async ({
    browser,
    baseURL,
    request,
  }) => {
    const folder = generateSyncFolderName('v3-bak-evidence');
    const remote = `${WEBDAV_CONFIG_TEMPLATE.baseUrl}${folder}/DEV/`;
    const config = { ...WEBDAV_CONFIG_TEMPLATE, syncFolderPath: `/${folder}` };
    await createSyncFolder(request, folder);
    const a = await setupSyncClient(browser, baseURL);
    let b: Awaited<ReturnType<typeof setupSyncClient>> | undefined;
    try {
      // A v2 device (Surgical sync saved off) creates the folder.
      const workA = new WorkViewPage(a.page);
      const syncA = new SyncPage(a.page);
      await workA.waitForTaskList();
      const first = `First v2 task ${folder}`;
      await workA.addTask(first);
      await waitForStatePersistence(a.page);
      await syncA.setupWebdavSync({ ...config, isUseSplitSyncFiles: false });
      await waitForSyncComplete(a.page, syncA);

      // Versions before 18.14 write no format choice. Without this, the joining
      // device would adopt A's saved "off" from the snapshot and never discover
      // the format (the setting-locality reproduction covers that).
      const created = await (
        await request.get(`${remote}sync-data.json`, {
          headers: { Authorization: authorization },
        })
      ).text();
      const prefixEnd = created.indexOf('__') + 2;
      const monolithWithChoice = JSON.parse(created.slice(prefixEnd)) as {
        state: { globalConfig: { sync: { isUseSplitSyncFiles?: boolean } } };
      };
      expect(monolithWithChoice.state.globalConfig.sync.isUseSplitSyncFiles).toBe(false);
      delete monolithWithChoice.state.globalConfig.sync.isUseSplitSyncFiles;
      const rewritten = await request.put(`${remote}sync-data.json`, {
        headers: { Authorization: authorization },
        data: `${created.slice(0, prefixEnd)}${JSON.stringify(monolithWithChoice)}`,
      });
      expect(rewritten.ok()).toBe(true);

      // A device with the default setting joins and records a cursor.
      b = await setupSyncClient(browser, baseURL);
      const workB = new WorkViewPage(b.page);
      const syncB = new SyncPage(b.page);
      await workB.waitForTaskList();
      await syncB.setupWebdavSync(config, { useProductFormatDefault: true });
      await waitForSyncComplete(b.page, syncB);
      await expect(b.page.locator('task').filter({ hasText: first })).toBeVisible();

      // The next v2 upload backs up the previous primary before replacing it.
      const second = `Second v2 task ${folder}`;
      await workA.addTask(second);
      await waitForStatePersistence(a.page);
      await syncA.triggerSync();
      await waitForSyncComplete(a.page, syncA);
      await syncB.triggerSync();
      await waitForSyncComplete(b.page, syncB);
      await expect(b.page.locator('task').filter({ hasText: second })).toBeVisible();
      const backup = await readPrefixedFile<{ version: number }>(
        request,
        `${remote}sync-data.json.bak`,
        authorization,
      );
      expect(backup.version).toBe(2);

      // Android local-folder writes delete sync-data.json before recreating it,
      // so a write killed in between leaves only the backup.
      const deleted = await request.delete(`${remote}sync-data.json`, {
        headers: { Authorization: authorization },
      });
      expect(deleted.ok()).toBe(true);

      // After a restart, B discovers the folder format again and re-seeds it.
      await b.page.reload();
      await waitForAppReady(b.page);
      await workB.waitForTaskList();
      await syncB.triggerSync();
      await waitForSyncComplete(b.page, syncB);

      const monolith = await readPrefixedFile<{ version: number; state: unknown }>(
        request,
        `${remote}sync-data.json`,
        authorization,
      );
      expect(monolith.version).toBe(2);
      expect(JSON.stringify(monolith.state)).toContain(second);
      expect(await remoteStatus(request, `${remote}sync-ops.json`)).toBe(404);

      // The v2 device keeps syncing the folder.
      await syncA.triggerSync();
      await waitForSyncComplete(a.page, syncA);
      await expect(a.page.locator('task').filter({ hasText: second })).toBeVisible();
    } finally {
      await closeContextsSafely(a.context, b?.context);
    }
  });
});
