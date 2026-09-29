import { NOOP_SYNC_LOGGER } from '@sp/sync-core';
import {
  LocalFileSyncAndroid,
  type LocalFileSyncAndroidDeps,
} from '@sp/sync-providers/local-file';
import { discoverFileSyncFormat } from './file-based-sync-format';
import { FILE_BASED_SYNC_CONSTANTS as C } from './file-based-sync.types';
import { RemoteFileNotFoundAPIError } from '../../core/errors/sync-errors';
import { FileSyncProvider } from '../provider.interface';
import { SyncProviderId } from '../provider.const';

const V2_BACKUP = `pf_2__${JSON.stringify({
  version: 2,
  syncVersion: 4,
  schemaVersion: 1,
  vectorClock: { android: 4 },
  lastModified: 1,
  clientId: 'android',
  state: { task: { ids: ['t1'] } },
  recentOps: [],
})}`;

/** A remote folder whose files are read like WebDAV reads them (a full GET). */
const remoteFolder = (files: Record<string, string>): FileSyncProvider<SyncProviderId> =>
  ({
    id: SyncProviderId.WebDAV,
    getFileRev: async (path: string) => {
      if (!(path in files)) throw new RemoteFileNotFoundAPIError(path);
      return { rev: `${path}-rev` };
    },
  }) as unknown as FileSyncProvider<SyncProviderId>;

/**
 * The real Android local-folder provider over a Storage Access Framework
 * double. SafBridgePlugin.writeFile deletes the file, creates it empty, then
 * writes it, so a killed write leaves the file missing or empty.
 */
const androidLocalFolder = (
  files: Map<string, string>,
): FileSyncProvider<SyncProviderId> =>
  // The package types its id as the 'LocalFile' literal; the app's provider type
  // uses SyncProviderId.LocalFile, which is the same string.
  new LocalFileSyncAndroid({
    logger: NOOP_SYNC_LOGGER,
    fileAdapter: {
      readFile: async (fileName: string) => {
        const data = files.get(fileName);
        if (data === undefined) throw new Error(`File not found: ${fileName}`);
        return data;
      },
      writeFile: async (fileName: string, data: string) => {
        files.set(fileName, data);
      },
      deleteFile: async (fileName: string) => {
        files.delete(fileName);
      },
    },
    credentialStore: {} as LocalFileSyncAndroidDeps['credentialStore'],
    saf: {
      selectFolder: async () => 'content://folder',
      checkPermission: async () => true,
    },
  }) as unknown as FileSyncProvider<SyncProviderId>;

describe('discoverFileSyncFormat', () => {
  it('reports a folder without sync files as empty', async () => {
    expect(await discoverFileSyncFormat(remoteFolder({}))).toBe('empty');
  });

  // A v2 upload writes sync-data.json.bak, then the primary. An interrupted
  // primary write leaves a v2 folder with only its backup.
  it('keeps a v2 folder whose primary write was interrupted on v2', async () => {
    expect(
      await discoverFileSyncFormat(remoteFolder({ [C.BACKUP_FILE]: V2_BACKUP })),
    ).toBe('v2');
  });

  it('keeps a split folder whose ops write was interrupted on v3', async () => {
    expect(
      await discoverFileSyncFormat(remoteFolder({ [C.OPS_BACKUP_FILE]: 'pf_3__{}' })),
    ).toBe('v3');
  });

  for (const killedAfter of ['delete', 'create'] as const) {
    it(`keeps an Android local folder on v2 when a write was killed after the ${killedAfter}`, async () => {
      const files = new Map<string, string>([[C.BACKUP_FILE, V2_BACKUP]]);
      if (killedAfter === 'create') files.set(C.SYNC_FILE, '');
      expect(await discoverFileSyncFormat(androidLocalFolder(files))).toBe('v2');
    });
  }
});
