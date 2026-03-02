export {
  OA_ROOT,
  PROFILES_DIR,
  DEFAULT_PROFILE,
  resolveProfile,
  ensureProfileDir,
  listProfiles,
  profileExists,
  type ProfilePaths,
} from './context.js';

export {
  setActiveProfile,
  getActiveProfile,
  getActiveProfileName,
  resetActiveProfile,
  setActiveProfilePaths,
} from './active.js';

export {
  hasLegacyData,
  migrateLegacyData,
  type MigrationResult,
} from './migrate.js';
