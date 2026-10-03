import { initDatabase } from '../db/database.js';
import { logger } from '../utils/logger.js';
import { traceStore } from '../utils/trace-store.js';
import { startDashboardServer, stopDashboardServer } from './server.js';
import { setInitialProfile, closeAll } from './db-manager.js';
import { getActiveProfileName } from '../profile/index.js';

/**
 * Run the dashboard as a standalone server process.
 * Initializes the DB, starts the HTTP server, and blocks until killed.
 */
export async function runStandalone(port?: number): Promise<void> {
  const profileName = getActiveProfileName();
  setInitialProfile(profileName);

  const db = initDatabase();
  logger.setDatabase(db);
  traceStore.setDatabase(db);

  const { server, url } = await startDashboardServer(db, port);

  console.log(`Open Accountant Dashboard running at ${url}`);
  console.log(`Profile: ${profileName}`);
  console.log('Press Ctrl+C to stop.');

  // Block until signal. Stop the server before closing the DBs (no request
  // may hit a closed handle), then exit: Bun.serve and onnxruntime's threads
  // otherwise keep the process — and the port — alive after "shutdown".
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.log('\nShutting down dashboard...');
      stopDashboardServer(server);
      closeAll();
      resolve();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  process.exit(0);
}
