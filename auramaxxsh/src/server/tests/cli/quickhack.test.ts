import { describe, it, expect } from 'vitest';
import { buildQuickhackPlan, QUICKHACK_NAMES, QUICKHACK_VALUES } from '../../cli/commands/quickhack';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('quickhack command', () => {
  it('is discoverable in root command help map', () => {
    const src = readFileSync(join(__dirname, '..', '..', '..', '..', 'bin/auramaxx.js'), 'utf8');
    expect(src).toContain("quickhack: 'Generate random tutorial secret");
  });

  it('builds set + inject plan with required env context', () => {
    const rng = () => 0;
    const plan = buildQuickhackPlan(rng);
    expect(QUICKHACK_NAMES).toContain(plan.name);
    expect(QUICKHACK_VALUES).toContain(plan.value);
    expect(plan.setArgs.slice(0, 2)).toEqual(['set', plan.name]);
    expect(plan.injectArgs).toEqual(['inject', plan.name, '--env', 'AURA_QUICKHACK']);
  });

  it('random picker can select from end of list', () => {
    const rng = () => 0.9999;
    const plan = buildQuickhackPlan(rng);
    expect(plan.name).toBe(QUICKHACK_NAMES[QUICKHACK_NAMES.length - 1]);
    expect(plan.value).toBe(QUICKHACK_VALUES[QUICKHACK_VALUES.length - 1]);
  });
});
