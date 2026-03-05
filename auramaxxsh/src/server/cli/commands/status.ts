/**
 * auramaxx status — Health check and wallet status
 */

import { serverUrl, fetchJson, isServerRunning } from '../lib/http';
import { getErrorMessage } from '../../lib/error';
import { printBanner, printStatus } from '../lib/theme';

interface SetupStatus {
  hasWallet: boolean;
  unlocked: boolean;
  address: string | null;
}

async function main() {
  const url = serverUrl();

  printBanner('STATUS');

  // Check API server
  const serverUp = await isServerRunning();
  printStatus('API Server', url, serverUp);

  // Check dashboard
  let dashboardUp = false;
  try {
    const resp = await fetch('http://localhost:4747');
    dashboardUp = resp.ok || resp.status === 200 || resp.status === 304;
  } catch {
    // Not running
  }
  printStatus('Dashboard UI', 'http://localhost:4747', dashboardUp);

  if (!serverUp) {
    console.log('\n  Run `npx auramaxx` to start API + dashboard services.');
    process.exit(0);
  }

  // Check wallet status
  try {
    const status = await fetchJson<SetupStatus>('/setup');
    console.log('');
    printStatus('Agent', status.hasWallet ? 'created' : 'not created', status.hasWallet);
    printStatus('Unlocked', status.unlocked ? 'yes' : 'no', status.unlocked);
    if (status.address) {
      printStatus('Address', status.address);
    }
  } catch (error) {
    const message = getErrorMessage(error);
    console.log(`\n  Could not fetch wallet status: ${message}`);
  }

  console.log('');
}

main().catch((error) => {
  console.error('Error:', getErrorMessage(error));
  process.exit(1);
});
