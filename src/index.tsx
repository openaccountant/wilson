#!/usr/bin/env bun
import { config } from 'dotenv';

// Load environment variables
config({ quiet: true });

const args = process.argv.slice(2);
const runIndex = args.indexOf('--run');

if (runIndex !== -1) {
  const query = args.slice(runIndex + 1).join(' ');
  if (!query) {
    console.error('Error: --run requires a query. Example: wilson --run "How much did I spend on dining?"');
    process.exit(1);
  }
  const { runHeadless } = await import('./headless.js');
  await runHeadless(query);
} else {
  const { runCli } = await import('./cli.js');
  await runCli();
}
