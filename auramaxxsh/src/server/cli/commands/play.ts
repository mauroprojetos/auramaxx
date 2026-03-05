import { execFileSync } from 'child_process';
import { printBanner, printSection, paint, ANSI } from '../lib/theme';

function parseArgs(argv: string[]) {
  const separatorIndex = argv.indexOf('--');
  const head = separatorIndex >= 0 ? argv.slice(0, separatorIndex) : argv;
  const tail = separatorIndex >= 0 ? argv.slice(separatorIndex + 1) : [];
  const positional = head.filter((arg) => !arg.startsWith('--'));
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    name: positional[0] || null,
    gameArgs: [...positional.slice(1), ...tail],
  };
}

function resolveGameBin(spec: string): string {
  const trimmed = spec.trim();
  if (!trimmed) return trimmed;

  if (trimmed.startsWith('@')) {
    const match = trimmed.match(/^@[^/]+\/([^@/]+)(?:@.+)?$/);
    return match?.[1] || trimmed;
  }

  const atIndex = trimmed.indexOf('@');
  return atIndex === -1 ? trimmed : trimmed.slice(0, atIndex);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.name) {
    printBanner('PLAY');
    console.log(`  ${paint('Usage:', ANSI.bold)} auramaxx play <game>`);
    console.log('');
    console.log(`  ${paint('Example:', ANSI.dim)} auramaxx play aurasu`);
    console.log(`  ${paint('Runs:', ANSI.dim)} npx aurasu play`);
    console.log('');
    if (!args.name && !args.help) {
      console.error(`  Missing game name.`);
      process.exit(1);
    }
    return;
  }

  const gameName = args.name;
  const gameBin = resolveGameBin(gameName);
  const gameArgs = args.gameArgs.length > 0 ? args.gameArgs : ['play'];

  printBanner(gameName.toUpperCase());
  printSection(gameName, 'Starting game...');

  try {
    execFileSync('npm', ['exec', '--yes', '--package', gameName, '--', gameBin, ...gameArgs], {
      stdio: 'inherit',
      env: process.env,
    });
  } catch (error: unknown) {
    const status = (error as { status?: number }).status;
    if (status) process.exit(status);
    throw error;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
