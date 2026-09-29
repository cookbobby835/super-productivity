import {
  applyLocalOnlySyncSettingsToAppData,
  LOCAL_ONLY_SYNC_DEVICE_KEYS,
  LOCAL_ONLY_SYNC_KEYS,
  LOCAL_ONLY_SYNC_SCHEDULE_KEYS,
  markSplitSyncFilesInAppData,
  pickLocalOnlySyncSettings,
  stripLocalOnlySyncScheduleSettings,
  stripLocalOnlySyncSettingsFromAppData,
  stripLocalOnlySyncSettingsFromGlobalConfig,
} from './local-only-sync-settings.util';
import { DEFAULT_GLOBAL_CONFIG } from './default-global-config.const';
import { SyncProviderId } from '../../op-log/sync-providers/provider.const';

describe('local-only sync settings utils', () => {
  it('schedule and device key sets are disjoint and exhaust LOCAL_ONLY_SYNC_KEYS', () => {
    const union = new Set<string>([
      ...LOCAL_ONLY_SYNC_SCHEDULE_KEYS,
      ...LOCAL_ONLY_SYNC_DEVICE_KEYS,
    ]);
    expect(union.size).toBe(
      LOCAL_ONLY_SYNC_SCHEDULE_KEYS.length + LOCAL_ONLY_SYNC_DEVICE_KEYS.length,
    );
    expect(union.size).toBe(LOCAL_ONLY_SYNC_KEYS.length);
  });

  it('should strip sync schedule settings from a sync config object', () => {
    const result = stripLocalOnlySyncScheduleSettings({
      syncInterval: 300000,
      isManualSyncOnly: true,
      isCompressionEnabled: true,
    }) as Record<string, unknown>;

    expect(result).toEqual({
      isCompressionEnabled: true,
    });
  });

  it('should strip local-only sync settings from app data', () => {
    const result = stripLocalOnlySyncSettingsFromAppData({
      globalConfig: {
        sync: {
          syncProvider: SyncProviderId.WebDAV,
          syncInterval: 300000,
          isManualSyncOnly: true,
          isCompressionEnabled: true,
        },
        misc: { isDisableAnimations: true },
      },
      task: { ids: [] },
    }) as Record<string, unknown>;

    const globalConfig = result['globalConfig'] as Record<string, unknown>;
    const sync = globalConfig['sync'] as Record<string, unknown>;

    expect(sync['syncProvider']).toBeNull();
    expect(sync['syncInterval']).toBeUndefined();
    expect(sync['isManualSyncOnly']).toBeUndefined();
    expect(sync['isCompressionEnabled']).toBe(true);
    expect(globalConfig['misc']).toEqual({ isDisableAnimations: true });
    expect(result['task']).toEqual({ ids: [] });
  });

  it('should strip local-only sync settings from a global config payload', () => {
    const result = stripLocalOnlySyncSettingsFromGlobalConfig({
      sync: {
        syncProvider: SyncProviderId.WebDAV,
        syncInterval: 300000,
        isManualSyncOnly: true,
        isCompressionEnabled: true,
      },
      misc: { isDisableAnimations: true },
    });

    expect(result).toEqual({
      sync: {
        syncProvider: null,
        isCompressionEnabled: true,
      },
      misc: { isDisableAnimations: true },
    });
  });

  it('should leave data without globalConfig.sync unchanged by reference', () => {
    const data = { task: { ids: [] } };

    expect(stripLocalOnlySyncSettingsFromAppData(data)).toBe(data);
  });

  it('should apply local-only sync settings to app data', () => {
    const result = applyLocalOnlySyncSettingsToAppData(
      {
        globalConfig: {
          sync: {
            syncProvider: SyncProviderId.Dropbox,
            syncInterval: 600000,
            isManualSyncOnly: false,
            isCompressionEnabled: true,
          },
        },
      },
      {
        isEnabled: true,
        isEncryptionEnabled: false,
        syncProvider: SyncProviderId.WebDAV,
        syncInterval: 300000,
        isManualSyncOnly: true,
      },
    ) as Record<string, unknown>;

    const globalConfig = result['globalConfig'] as Record<string, unknown>;
    const sync = globalConfig['sync'] as Record<string, unknown>;

    expect(sync['isEnabled']).toBe(true);
    expect(sync['syncProvider']).toBe(SyncProviderId.WebDAV);
    expect(sync['syncInterval']).toBe(300000);
    expect(sync['isManualSyncOnly']).toBe(true);
    expect(sync['isCompressionEnabled']).toBe(true);
  });

  it('should pick every local-only key, including an absent Surgical sync choice', () => {
    const picked = pickLocalOnlySyncSettings({
      ...DEFAULT_GLOBAL_CONFIG.sync,
      syncProvider: SyncProviderId.WebDAV,
      isCompressionEnabled: true,
    });

    expect(Object.keys(picked).sort()).toEqual([...LOCAL_ONLY_SYNC_KEYS].sort());
    expect(picked.syncProvider).toBe(SyncProviderId.WebDAV);
    expect(picked.isUseSplitSyncFiles).toBeUndefined();
  });

  it('should mark v3 snapshot data as Surgical sync for released readers', () => {
    for (const saved of [false, undefined]) {
      const result = markSplitSyncFilesInAppData({
        globalConfig: {
          sync: { isUseSplitSyncFiles: saved, isCompressionEnabled: true },
        },
        task: { ids: [] },
      }) as { globalConfig: { sync: Record<string, unknown> }; task: unknown };

      expect(result.globalConfig.sync).toEqual({
        isUseSplitSyncFiles: true,
        isCompressionEnabled: true,
      });
      expect(result.task).toEqual({ ids: [] });
    }
    const withoutSync = { task: { ids: [] } };
    expect(markSplitSyncFilesInAppData(withoutSync)).toBe(withoutSync);
  });
});
