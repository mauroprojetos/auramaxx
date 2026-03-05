#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import { parseScenarioDocument, validateScenario } from '../../lib/e2e-agent/validation';

function listScenarios(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];

  return fs
    .readdirSync(rootDir)
    .filter((name) => name.endsWith('.scenario.yaml') || name.endsWith('.scenario.json'))
    .map((name) => path.join(rootDir, name));
}

function main() {
  const [command, arg] = process.argv.slice(2);
  const scenariosDir = path.resolve(__dirname, 'scenarios');

  if (command === 'list') {
    for (const scenarioPath of listScenarios(scenariosDir)) {
      console.log(path.basename(scenarioPath));
    }
    return;
  }

  if (command === 'validate') {
    if (!arg) {
      console.error('Usage: runner.ts validate <scenario-file>');
      process.exit(1);
    }

    const input = fs.readFileSync(path.resolve(arg), 'utf8');
    const parsed = parseScenarioDocument(input);
    validateScenario(parsed);
    console.log('OK');
    return;
  }

  console.error('Usage: runner.ts <list|validate> [args]');
  process.exit(1);
}

main();
