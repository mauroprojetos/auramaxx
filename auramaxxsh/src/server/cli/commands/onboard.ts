import { execFileSync } from 'child_process';
import { printBanner, printComplete, paint, ANSI } from '../lib/theme';
import { promptSelect } from '../lib/prompt';

async function main() {
  printBanner();

  const choice = await promptSelect(
    '  Ready to auramaxx?',
    [{ value: 'yes', label: 'Yes', aliases: ['y', '1'] }],
    'yes',
  );

  if (choice !== 'yes') return;

  console.log('');
  console.log('  Installing auramaxx globally...');
  console.log('');

  try {
    execFileSync('npm', ['install', '-g', 'auramaxx'], {
      stdio: 'inherit',
      timeout: 120000,
    });
  } catch (error: unknown) {
    console.error('');
    console.error('  Failed to install globally. Try manually: npm install -g auramaxx');
    process.exit((error as { status?: number }).status || 1);
  }

  printComplete('auramaxx installed. Get started with:');
  console.log(`    ${paint('auramaxx start', ANSI.fgAccent)}`);
  console.log('');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
