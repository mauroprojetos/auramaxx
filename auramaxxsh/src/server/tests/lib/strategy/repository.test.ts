/**
 * Tests for strategy repository — manifest validation on deserialization
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { testPrisma, cleanDatabase } from '../../setup';
import { listPersistedStrategies } from '../../../lib/strategy/repository';

describe('listPersistedStrategies() manifest validation', () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it('filters out rows with invalid JSON manifest', async () => {
    await testPrisma.strategy.create({
      data: {
        id: 'bad-json',
        name: 'Bad JSON',
        mode: 'headless',
        manifest: 'invalid-json{{',
        config: '{}',
        state: '{}',
        schedule: '{}',
        permissions: '[]',
        enabled: false,
        status: 'draft',
        createdBy: 'test',
      },
    });

    const result = await listPersistedStrategies();
    expect(result.find((s) => s.id === 'bad-json')).toBeUndefined();
  });

  it('filters out rows with manifest missing hooks', async () => {
    await testPrisma.strategy.create({
      data: {
        id: 'no-hooks',
        name: 'No Hooks',
        mode: 'headless',
        manifest: JSON.stringify({ id: 'no-hooks', name: 'No Hooks' }),
        config: '{}',
        state: '{}',
        schedule: '{}',
        permissions: '[]',
        enabled: false,
        status: 'draft',
        createdBy: 'test',
      },
    });

    const result = await listPersistedStrategies();
    expect(result.find((s) => s.id === 'no-hooks')).toBeUndefined();
  });

  it('includes rows with valid manifest (id, name, hooks present)', async () => {
    await testPrisma.strategy.create({
      data: {
        id: 'valid',
        name: 'Valid Strategy',
        mode: 'headless',
        manifest: JSON.stringify({
          id: 'valid',
          name: 'Valid Strategy',
          hooks: { tick: 'Return no intents.' },
          sources: [],
          config: {},
          permissions: [],
        }),
        config: '{}',
        state: '{}',
        schedule: '{}',
        permissions: '[]',
        enabled: false,
        status: 'draft',
        createdBy: 'test',
      },
    });

    const result = await listPersistedStrategies();
    const found = result.find((s) => s.id === 'valid');
    expect(found).toBeDefined();
    expect(found!.name).toBe('Valid Strategy');
  });
});
