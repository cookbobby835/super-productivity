import { DEFAULT_GLOBAL_CONFIG } from '../../features/config/default-global-config.const';
import { GlobalConfigState } from '../../features/config/global-config.model';
import {
  applyLocalOnlySyncSettingsToAppData,
  LocalOnlySyncSettings,
} from '../../features/config/local-only-sync-settings.util';
import { getInitialAppFeatures } from '../../features/config/new-install-app-features.const';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

type RemoteRebuildBaselineState = Record<string, unknown> & {
  globalConfig: GlobalConfigState;
};

/**
 * The state a USE_REMOTE rebuild persists before it replays the server history:
 * the remote snapshot, or the model defaults when the history has none.
 *
 * getDefaultMainModelData intentionally excludes globalConfig. Add a default
 * config shell before applying the canonical device-local fields so an
 * interrupted rebuild can hydrate enough configuration to sync again. Without a
 * snapshot, the shell starts with the app features a fresh install starts with,
 * so a rebuilt device matches a fresh one joining the account; a snapshot's own
 * appFeatures win (#10399).
 */
export const buildRemoteRebuildBaselineState = (
  baselineSource: Record<string, unknown>,
  localOnlySyncSettings: LocalOnlySyncSettings,
): RemoteRebuildBaselineState => {
  const baselineGlobalConfig = asRecord(baselineSource['globalConfig']);
  return applyLocalOnlySyncSettingsToAppData(
    {
      ...baselineSource,
      globalConfig: {
        ...DEFAULT_GLOBAL_CONFIG,
        appFeatures: getInitialAppFeatures(),
        ...baselineGlobalConfig,
        sync: {
          ...DEFAULT_GLOBAL_CONFIG.sync,
          ...asRecord(baselineGlobalConfig['sync']),
        },
      } as GlobalConfigState,
    },
    localOnlySyncSettings,
  );
};
