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

test.describe('@webdav Surgical sync is a per-device choice', () => {
  test.beforeEach(async ({ webdavServerUp }) => {
    void webdavServerUp;
  });

  // "Surgical sync" off is a deliberate choice to keep v2 (for example for
  // devices older than 18.14). Syncing must not replace that choice with
  // another device's value, or with a missing one from a snapshot.
  test('a device that saved Surgical sync off keeps it after another device upgrades the folder', async ({
    browser,
    baseURL,
    request,
  }) => {
    const folder = generateSyncFolderName('v3-setting-local');
    const remote = `${WEBDAV_CONFIG_TEMPLATE.baseUrl}${folder}/DEV/`;
    const config = { ...WEBDAV_CONFIG_TEMPLATE, syncFolderPath: `/${folder}` };
    await createSyncFolder(request, folder);
    const a = await setupSyncClient(browser, baseURL);
    let b: Awaited<ReturnType<typeof setupSyncClient>> | undefined;
    try {
      // A creates a v2 folder without saving a format choice.
      const workA = new WorkViewPage(a.page);
      const syncA = new SyncPage(a.page);
      await workA.waitForTaskList();
      const first = `First task ${folder}`;
      await workA.addTask(first);
      await waitForStatePersistence(a.page);
      await syncA.setupWebdavSync(config, { useProductFormatDefault: true });
      await waitForSyncComplete(a.page, syncA);
      const monolith = await readPrefixedFile<{
        version: number;
        state: { globalConfig: { sync: { isUseSplitSyncFiles?: boolean } } };
      }>(request, `${remote}sync-data.json`, authorization);
      expect(monolith.version).toBe(2);
      expect(monolith.state.globalConfig.sync.isUseSplitSyncFiles).toBeUndefined();

      // B saves Surgical sync off and joins; it hydrates A's snapshot.
      b = await setupSyncClient(browser, baseURL);
      const workB = new WorkViewPage(b.page);
      const syncB = new SyncPage(b.page);
      await workB.waitForTaskList();
      await syncB.setupWebdavSync({ ...config, isUseSplitSyncFiles: false });
      await waitForSyncComplete(b.page, syncB);
      await expect(b.page.locator('task').filter({ hasText: first })).toBeVisible();

      // A turns Surgical sync on; its next upload upgrades the folder to v3.
      await syncA.setupWebdavSync(
        { ...config, isUseSplitSyncFiles: true },
        { isReconfigure: true },
      );
      await waitForSyncComplete(a.page, syncA);
      await workA.addTask(`Upgraded folder task ${folder}`);
      await waitForStatePersistence(a.page);
      await syncA.triggerSync();
      await waitForSyncComplete(a.page, syncA);
      const ops = await readPrefixedFile<{ version: number }>(
        request,
        `${remote}sync-ops.json`,
        authorization,
      );
      expect(ops.version).toBe(3);
      // Released 18.14–19.1 readers apply the snapshot's value and read a
      // missing one as off, so the migrated snapshot must say on.
      const migrated = await readPrefixedFile<{
        state: { globalConfig: { sync: { isUseSplitSyncFiles?: boolean } } };
      }>(request, `${remote}sync-state.json`, authorization);

      // B still has Surgical sync off, so it stops at the upgraded folder and
      // shows the notice. It must not join with a choice it never made.
      await syncB.triggerSync();
      const joinedSilently = await waitForSyncComplete(b.page, syncB).then(
        () => true,
        () => false,
      );
      const showsNotice = await b.page
        .locator('snack-custom .message')
        .filter({ hasText: /split-file format.*Surgical sync/i })
        .first()
        .waitFor({ timeout: 5000 })
        .then(
          () => true,
          () => false,
        );
      await syncB.syncBtn.click({ button: 'right' });
      const dialog = b.page.locator('mat-dialog-container');
      await syncB.expandAdvancedSettings();
      const surgicalSyncOn = await dialog
        .getByRole('checkbox', { name: /Surgical sync/i })
        .isChecked();
      await dialog.locator('mat-dialog-actions button[mat-button]').click();
      await expect(dialog).toBeHidden();
      expect({
        joinedSilently,
        showsNotice,
        surgicalSyncOn,
        migratedSnapshotChoice: migrated.state.globalConfig.sync.isUseSplitSyncFiles,
      }).toEqual({
        joinedSilently: false,
        showsNotice: true,
        surgicalSyncOn: false,
        migratedSnapshotChoice: true,
      });
    } finally {
      await closeContextsSafely(a.context, b?.context);
    }
  });
});
