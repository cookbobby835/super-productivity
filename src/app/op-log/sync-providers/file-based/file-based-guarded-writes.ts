import { FileSyncProvider } from '../provider.interface';
import { SyncProviderId } from '../provider.const';
import { EncryptAndCompressHandlerService } from '../../encryption/encrypt-and-compress-handler.service';
import { EncryptAndCompressCfg } from '../../core/types/sync.types';
import {
  FileBasedSplitTombstone,
  FILE_BASED_SYNC_CONSTANTS,
} from './file-based-sync.types';

declare const GUARDED_PROVIDER_BRAND: unique symbol;

/**
 * A file provider whose `uploadFile`/`removeFile` are wrapped by
 * `_withTargetGuard` — a write aborts if the target changed mid-operation. Every
 * write-path helper takes this branded type instead of the raw provider, so the
 * compiler rejects passing an unguarded provider to a write path: the in-flight
 * guard invariant is enforced at compile time, not by call-graph convention (a
 * future entry point or helper that forgets the guard is a build error, not a
 * silent cross-target write). Only the raw entry points `createAdapter` and the
 * intentionally-unguarded `_deleteAllData` keep `FileSyncProvider`. (Task 2.)
 */
export type GuardedFileSyncProvider = FileSyncProvider<SyncProviderId> & {
  readonly [GUARDED_PROVIDER_BRAND]: true;
};

/**
 * Neutralizes `sync-data.json.bak` and then overwrites `sync-data.json` with a
 * v3 split tombstone (NEVER deletes it), so an old client's SPAP-8 `.bak`
 * recovery cannot resurrect a v2 file and diverge. Order matters — see the
 * inline comment.
 */
export const writeTombstoneAndNeutralizeBak = async (
  provider: GuardedFileSyncProvider,
  handler: EncryptAndCompressHandlerService,
  cfg: EncryptAndCompressCfg,
  encryptKey: string | undefined,
  expectedLegacyRev?: string | null,
): Promise<void> => {
  const tombstone: FileBasedSplitTombstone = {
    version: FILE_BASED_SYNC_CONSTANTS.SPLIT_FILE_VERSION,
    format: FILE_BASED_SYNC_CONSTANTS.SPLIT_TOMBSTONE_FORMAT,
    migratedAt: Date.now(),
    note: 'Upgraded to split-file sync; update the app / enable Surgical sync to continue.',
  };
  const encoded = await handler.compressAndEncryptData(
    cfg,
    encryptKey,
    tombstone,
    FILE_BASED_SYNC_CONSTANTS.SPLIT_FILE_VERSION,
  );
  // Neutralize the legacy .bak FIRST, then the tombstone. In the old order
  // (tombstone first, .bak best-effort) a crash/failure between the two left a
  // live v2 .bak next to the tombstone: an OFF client reading the tombstone
  // gets SyncDataCorruptedError → SPAP-8 recovery adopts the v2 .bak → its
  // next upload heals v2 back OVER the tombstone, forking the folder into two
  // sync worlds. Neutralize-first is crash-safe (a crash in between leaves a
  // valid v2 primary + tombstone .bak — nothing recoverable, nothing stale)
  // and the failure is deliberately FATAL: better a missing tombstone (OFF
  // clients are still caught by the ops-file probe in _downloadSyncFile) than
  // a tombstone with a resurrectable v2 .bak beside it.
  //
  // Migration passes the exact downloaded legacy rev, making the primary
  // tombstone conditional. A mismatch leaves the pending ops marker intact;
  // the recovery loop imports the newer v2 payload and retries. Explicit
  // snapshot replacement omits the rev and intentionally force-overwrites.
  // null reserves a new folder with a conditional create, before publishing ops.
  // There is no prior v2 primary to back up in that case.
  if (expectedLegacyRev !== null) {
    await provider.uploadFile(FILE_BASED_SYNC_CONSTANTS.BACKUP_FILE, encoded, null, true);
  }
  // Overwrite the legacy single file in place (never remove it).
  await provider.uploadFile(
    FILE_BASED_SYNC_CONSTANTS.SYNC_FILE,
    encoded,
    expectedLegacyRev ?? null,
    expectedLegacyRev === undefined,
  );
};
