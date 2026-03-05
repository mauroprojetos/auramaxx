import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { printBanner, printSection, paint, ANSI } from '../lib/theme';
import { promptInput, promptSelect } from '../lib/prompt';

const TEMPLATE_OPTIONS = [
  { value: '2d-shooter', label: '[2D] Shooter', aliases: ['1', '2', '2d', 'shooter', '2d shooter'] },
  { value: '3d-platformer', label: '[3D] Platformer', aliases: ['3', '3d', 'platformer', 'platformers', '3d platformer'] },
  { value: 'blank', label: 'Blank', aliases: ['b'] },
];

const VALID_TEMPLATES = new Set(TEMPLATE_OPTIONS.map((option) => option.value));
const TEMPLATE_ALIASES: Record<string, string> = {
  '2d': '2d-shooter',
  'shooter': '2d-shooter',
  '2d shooter': '2d-shooter',
  '2d-shooter': '2d-shooter',
  '3d': '3d-platformer',
  'platformer': '3d-platformer',
  'platformers': '3d-platformer',
  '3d platformer': '3d-platformer',
  '3d-platformer': '3d-platformer',
  'blank': 'blank',
};
const COMMAND_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_AURAJS_CLI = path.resolve(
  COMMAND_DIR,
  '../../../../../packages/aurascript/src/cli/src/cli.mjs',
);

function parseArgs(argv: string[]) {
  let name: string | null = null;
  let template: string | null = null;
  const passthrough: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      return { help: true, name, template, passthrough };
    }

    if (arg === '--template') {
      template = argv[i + 1] || null;
      i += 1;
      continue;
    }

    if (arg.startsWith('--template=')) {
      template = arg.slice('--template='.length);
      continue;
    }

    if (!name && !arg.startsWith('--')) {
      name = arg;
      continue;
    }

    passthrough.push(arg);
  }

  return { help: false, name, template, passthrough };
}

function normalizeTemplate(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return null;
  return TEMPLATE_ALIASES[normalized] || normalized;
}

function resolveInvocationCwd(): string {
  const forwardedCwd = process.env.AURA_INVOKE_CWD;
  if (forwardedCwd && path.isAbsolute(forwardedCwd)) {
    return forwardedCwd;
  }

  const shellPwd = process.env.PWD;
  if (shellPwd && path.isAbsolute(shellPwd)) {
    return shellPwd;
  }
  return process.cwd();
}

async function resolveGameName(initialName: string | null): Promise<string> {
  if (initialName && initialName.trim().length > 0) {
    return initialName.trim();
  }

  while (true) {
    const answer = await promptInput('  Game name / folder');
    if (answer) return answer;
    console.error('  Game name is required.');
  }
}

async function resolveTemplate(initialTemplate: string | null): Promise<string> {
  const normalized = normalizeTemplate(initialTemplate);
  if (normalized && VALID_TEMPLATES.has(normalized)) {
    return normalized;
  }

  if (normalized && !VALID_TEMPLATES.has(normalized)) {
    console.log(`  Unknown template "${normalized}"; choose one below.`);
  }

  return promptSelect('  Starter template', TEMPLATE_OPTIONS, '2d-shooter');
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help) {
    printBanner('CREATE');
    console.log(`  ${paint('Usage:', ANSI.bold)} auramaxx create [name] [--template <2d-shooter|3d-platformer|blank>] [--skip-install]`);
    console.log('');
    console.log('  Styled wrapper around AuraJS create scaffolding.');
    console.log(`  ${paint('Example:', ANSI.dim)} auramaxx create my-game --template 3d-platformer`);
    console.log('');
    return;
  }

  printBanner('CREATE');
  printSection('New AuraJS Game', 'AuraMaxx styling + prompts, delegated to AuraJS scaffolder.');

  const name = await resolveGameName(parsed.name);
  const template = await resolveTemplate(parsed.template);
  const invocationCwd = resolveInvocationCwd();

  printSection('Scaffolding', `Delegating to AuraJS (${template})...`);

  const auraArgs = ['create', name, '--template', template, ...parsed.passthrough];

  try {
    if (existsSync(LOCAL_AURAJS_CLI)) {
      execFileSync(process.execPath, [LOCAL_AURAJS_CLI, ...auraArgs], {
        cwd: invocationCwd,
        stdio: 'inherit',
        env: process.env,
      });
    } else {
      execFileSync(
        'npm',
        ['exec', '--yes', '--package', '@auraindustry/aurajs', '--', 'aura', ...auraArgs],
        {
          cwd: invocationCwd,
          stdio: 'inherit',
          env: process.env,
        },
      );
    }
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
