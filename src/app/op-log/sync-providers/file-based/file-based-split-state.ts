import {
  FileBasedStateFile,
  FileBasedSyncData,
  FILE_BASED_SYNC_CONSTANTS,
} from './file-based-sync.types';

/** The split `sync-state.json` payload that migrates a v2 `sync-data.json`. */
export const buildSplitMigrationState = (
  legacy: FileBasedSyncData,
  clientId: string,
): FileBasedStateFile => {
  return {
    version: FILE_BASED_SYNC_CONSTANTS.SPLIT_FILE_VERSION,
    syncVersion: legacy.syncVersion,
    schemaVersion: legacy.schemaVersion ?? 1,
    vectorClock: legacy.vectorClock,
    lastModified: Date.now(),
    clientId,
    state: legacy.state,
    archiveYoung: legacy.archiveYoung,
    archiveOld: legacy.archiveOld,
  };
};
