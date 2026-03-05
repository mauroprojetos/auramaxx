import { describe, expect, it } from 'vitest';
import {
  E2E_AGENT_ERROR_CODES,
  LANE_BUDGET_CAPS,
  REPO_DEFAULT_BUDGET,
} from '../../lib/e2e-agent/contracts';
import {
  E2EAgentValidationError,
  applyBudgetPolicy,
  enforceClockDrift,
  enforceEgressPolicy,
  enforceRuntimeBudget,
  parseScenarioDocument,
  validateScenario,
} from '../../lib/e2e-agent/validation';

describe('e2e-agent scenario validation contracts', () => {
  it('parses yaml and validates a valid scenario', () => {
    const parsed = parseScenarioDocument(`
      id: credential-create-basic
      title: Credential Create Basic
      mode: scripted
      clock:
        baseTimeIso: '2026-02-16T12:00:00.000Z'
      assertions:
        - id: create-form
          type: ui
          op: exists
          selector: '#form'
    `);

    const scenario = validateScenario(parsed);
    expect(scenario.id).toBe('credential-create-basic');
  });

  it('fails with E_SCHEMA_ASSERTION when assertion fields are missing', () => {
    const parsed = parseScenarioDocument(`
      id: bad-scenario
      title: Broken
      mode: scripted
      clock:
        baseTimeIso: '2026-02-16T12:00:00.000Z'
      assertions:
        - type: ui
          op: exists
          selector: '#form'
    `);

    expect(() => validateScenario(parsed)).toThrowError(E2EAgentValidationError);

    try {
      validateScenario(parsed);
    } catch (error) {
      expect((error as E2EAgentValidationError).code).toBe(E2E_AGENT_ERROR_CODES.schemaAssertion);
    }
  });

  it('applies repo default budget and enforces lane caps', () => {
    const budget = applyBudgetPolicy(undefined, 'pr-smoke');
    expect(budget).toEqual(REPO_DEFAULT_BUDGET);
    expect(budget.maxDurationSec).toBeLessThanOrEqual(LANE_BUDGET_CAPS['pr-smoke'].maxDurationSec);

    expect(() =>
      applyBudgetPolicy(
        {
          maxDurationSec: LANE_BUDGET_CAPS['pr-smoke'].maxDurationSec + 1,
        },
        'pr-smoke'
      )
    ).toThrowError(E2EAgentValidationError);
  });

  it('fails unknown outbound hosts with E_EGRESS_POLICY', () => {
    expect(() => enforceEgressPolicy('example.com', ['localhost'])).toThrowError(E2EAgentValidationError);

    try {
      enforceEgressPolicy('example.com', ['localhost']);
    } catch (error) {
      expect((error as E2EAgentValidationError).code).toBe(E2E_AGENT_ERROR_CODES.egressPolicy);
    }
  });

  it('fails drift greater than 50ms with E_CLOCK_DRIFT', () => {
    expect(() =>
      enforceClockDrift({
        runnerMs: 1000,
        serverMs: 1030,
        browserMs: 1060,
        fixtureMs: 1010,
      })
    ).toThrowError(E2EAgentValidationError);

    try {
      enforceClockDrift({
        runnerMs: 1000,
        serverMs: 1030,
        browserMs: 1060,
        fixtureMs: 1010,
      });
    } catch (error) {
      expect((error as E2EAgentValidationError).code).toBe(E2E_AGENT_ERROR_CODES.clockDrift);
    }
  });

  it('emits budget-specific hard-fail error codes for runtime overages', () => {
    const budget = {
      maxDurationSec: 10,
      maxSteps: 2,
      maxToolCalls: 1,
      maxTokens: 100,
    };

    const overages = [
      { usage: { durationSec: 11, steps: 1, toolCalls: 1, tokens: 10 }, code: E2E_AGENT_ERROR_CODES.budgetDuration },
      { usage: { durationSec: 1, steps: 3, toolCalls: 1, tokens: 10 }, code: E2E_AGENT_ERROR_CODES.budgetSteps },
      { usage: { durationSec: 1, steps: 1, toolCalls: 2, tokens: 10 }, code: E2E_AGENT_ERROR_CODES.budgetToolCalls },
      { usage: { durationSec: 1, steps: 1, toolCalls: 1, tokens: 101 }, code: E2E_AGENT_ERROR_CODES.budgetTokens },
    ] as const;

    for (const { usage, code } of overages) {
      try {
        enforceRuntimeBudget(usage, budget);
        throw new Error('expected overage to throw');
      } catch (error) {
        expect((error as E2EAgentValidationError).code).toBe(code);
      }
    }
  });
});
