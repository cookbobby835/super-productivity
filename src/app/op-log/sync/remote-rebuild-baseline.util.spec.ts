import { DEFAULT_GLOBAL_CONFIG } from '../../features/config/default-global-config.const';
import { LS } from '../../core/persistence/storage-keys.const';
import { NEW_INSTALL_APP_FEATURES } from '../../features/config/new-install-app-features.const';
import { SyncProviderId } from '../sync-providers/provider.const';
import { buildRemoteRebuildBaselineState } from './remote-rebuild-baseline.util';

describe('buildRemoteRebuildBaselineState', () => {
  const localOnlySyncSettings = {
    isEnabled: true,
    isEncryptionEnabled: true,
    syncProvider: SyncProviderId.SuperSync,
    syncInterval: 17,
    isManualSyncOnly: true,
  };

  let skipTourValue: string | null;
  beforeEach(() => {
    // getInitialAppFeatures() keeps every feature on for E2E runs that set this.
    skipTourValue = localStorage.getItem(LS.IS_SKIP_TOUR);
    localStorage.removeItem(LS.IS_SKIP_TOUR);
  });
  afterEach(() => {
    if (skipTourValue !== null) {
      localStorage.setItem(LS.IS_SKIP_TOUR, skipTourValue);
    }
  });

  it('starts a history without a snapshot from the new-install app features (#10399)', () => {
    const baseline = buildRemoteRebuildBaselineState(
      { task: { ids: [], entities: {} } },
      localOnlySyncSettings,
    );

    expect(baseline.globalConfig.appFeatures).toEqual(NEW_INSTALL_APP_FEATURES);
    expect(baseline.globalConfig.misc).toEqual(DEFAULT_GLOBAL_CONFIG.misc);
    expect(baseline['task']).toEqual({ ids: [], entities: {} });
  });

  it("keeps a snapshot's own appFeatures", () => {
    const snapshotAppFeatures = {
      ...DEFAULT_GLOBAL_CONFIG.appFeatures,
      isBoardsEnabled: true,
      isHabitsEnabled: false,
    };

    const baseline = buildRemoteRebuildBaselineState(
      { globalConfig: { appFeatures: snapshotAppFeatures } },
      localOnlySyncSettings,
    );

    expect(baseline.globalConfig.appFeatures).toEqual(snapshotAppFeatures);
  });

  it('applies the device-local sync settings over the default sync config', () => {
    const baseline = buildRemoteRebuildBaselineState(
      { globalConfig: { sync: { isCompressionEnabled: true } } },
      localOnlySyncSettings,
    );

    expect(baseline.globalConfig.sync).toEqual({
      ...DEFAULT_GLOBAL_CONFIG.sync,
      isCompressionEnabled: true,
      ...localOnlySyncSettings,
    });
  });
});
