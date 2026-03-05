/**
 * auramaxx unlock — Unlock the agent interactively
 */

import { fetchPublicKey, fetchJson, isServerRunning } from '../lib/http';
import { promptPassword } from '../lib/prompt';
import { encryptPassword, generateAgentKeypair } from '../../cli/transport-client';
import { getErrorMessage } from '../../lib/error';

async function main() {
  // Check server is running
  if (!(await isServerRunning())) {
    console.error('Wallet server is not running.');
    console.error('Start it with: npx auramaxx');
    process.exit(1);
  }

  // Get public key
  const publicKey = await fetchPublicKey();

  // Prompt for password
  const password = await promptPassword('Password');

  // Encrypt and unlock
  const encrypted = encryptPassword(password, publicKey);
  const { publicKey: agentPubkey } = generateAgentKeypair();

  try {
    const result = await fetchJson<{
      success: boolean;
      address: string;
      token: string;
      error?: string;
    }>('/unlock', { body: { encrypted, pubkey: agentPubkey } });

    console.log(`\nWallet unlocked.`);
    console.log(`  Address: ${result.address}`);
    console.log('  Token:   [HIDDEN]');
    process.exit(0);
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error(`\nFailed to unlock: ${msg}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Error:', getErrorMessage(error));
  process.exit(1);
});
