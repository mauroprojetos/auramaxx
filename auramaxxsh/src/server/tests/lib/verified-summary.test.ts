/**
 * Tests for server/lib/verified-summary.ts
 */
import { describe, it, expect } from 'vitest';
import { generateVerifiedSummary, detectDiscrepancies, PERMISSION_LABELS } from '../../lib/verified-summary';
import { parseEther } from 'ethers';

/** Helper: convert ETH string to wei string */
const eth = (val: string): string => parseEther(val).toString();

describe('generateVerifiedSummary()', () => {
  describe('swap endpoint', () => {
    it('should extract swap facts (wei → ETH)', () => {
      const result = generateVerifiedSummary({
        agentId: 'test-agent',
        summary: 'Buy token for 0.01 ETH',
        permissions: ['swap'],
        limits: { swap: 0.01 },
        ttl: 120,
        action: {
          endpoint: '/swap',
          method: 'POST',
          body: {
            from: '0x1234567890abcdef1234567890abcdef12345678',
            token: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
            direction: 'buy',
            amount: eth('0.01'),
            slippage: 0.5,
            chain: 'base',
            dex: 'uniswap',
          },
        },
      });

      expect(result.action).toBe('/swap');
      expect(result.oneLiner).toContain('Buy');
      expect(result.oneLiner).toContain('0.01');
      expect(result.oneLiner).toContain('ETH');
      expect(result.oneLiner).toContain('base');
      expect(result.verified).toBe(true);

      const labels = result.facts.map(f => f.label);
      expect(labels).toContain('From wallet');
      expect(labels).toContain('Token');
      expect(labels).toContain('Direction');
      expect(labels).toContain('Amount');
      expect(labels).toContain('Slippage');
      expect(labels).toContain('Chain');
      expect(labels).toContain('DEX');
    });

    it('should handle sell direction', () => {
      const result = generateVerifiedSummary({
        agentId: 'test-agent',
        summary: 'Sell token',
        permissions: ['swap'],
        action: {
          endpoint: '/swap',
          method: 'POST',
          body: {
            token: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
            direction: 'sell',
            amount: eth('1.0'),
            chain: 'base',
          },
        },
      });

      expect(result.oneLiner).toContain('Sell');
    });
  });

  describe('send endpoint', () => {
    it('should extract send facts', () => {
      const result = generateVerifiedSummary({
        agentId: 'test-agent',
        summary: 'Send 0.1 ETH',
        permissions: ['send:hot'],
        action: {
          endpoint: '/send',
          method: 'POST',
          body: {
            from: '0x1234567890abcdef1234567890abcdef12345678',
            to: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
            amount: eth('0.1'),
            chain: 'base',
          },
        },
      });

      expect(result.action).toBe('/send');
      expect(result.oneLiner).toContain('Send');
      expect(result.oneLiner).toContain('0.1');
      expect(result.oneLiner).toContain('ETH');
      expect(result.verified).toBe(true);

      const labels = result.facts.map(f => f.label);
      expect(labels).toContain('From');
      expect(labels).toContain('To');
      expect(labels).toContain('Amount');
    });

    it('should flag raw Solana transaction', () => {
      const result = generateVerifiedSummary({
        agentId: 'test-agent',
        summary: 'Send 1 SOL',
        permissions: ['send:hot'],
        action: {
          endpoint: '/send',
          method: 'POST',
          body: {
            to: 'ABC123',
            transaction: 'base64encodedtx...',
            chain: 'solana',
          },
        },
      });

      expect(result.oneLiner).toContain('raw transaction');
      const rawFact = result.facts.find(f => f.label === 'Raw transaction');
      expect(rawFact).toBeDefined();
    });
  });

  describe('fund endpoint', () => {
    it('should extract fund facts', () => {
      const result = generateVerifiedSummary({
        agentId: 'test-agent',
        summary: 'Fund hot wallet with 1 ETH',
        permissions: ['fund'],
        limits: { fund: 1.0 },
        action: {
          endpoint: '/fund',
          method: 'POST',
          body: {
            to: '0x1234567890abcdef1234567890abcdef12345678',
            amount: eth('1.0'),
            chain: 'base',
          },
        },
      });

      expect(result.action).toBe('/fund');
      expect(result.oneLiner).toContain('Fund');
      expect(result.oneLiner).toContain('1.0');
      expect(result.oneLiner).toContain('cold');
      expect(result.verified).toBe(true);
    });
  });

  describe('launch endpoint', () => {
    it('should extract launch facts', () => {
      const result = generateVerifiedSummary({
        agentId: 'test-agent',
        summary: 'Launch MTK token',
        permissions: ['launch'],
        action: {
          endpoint: '/launch',
          method: 'POST',
          body: {
            from: '0x1234567890abcdef1234567890abcdef12345678',
            name: 'MyToken',
            symbol: 'MTK',
            type: 'multicurve',
            chain: 'base',
          },
        },
      });

      expect(result.action).toBe('/launch');
      expect(result.oneLiner).toContain('MTK');
      expect(result.oneLiner).toContain('multicurve');
      expect(result.oneLiner).toContain('base');
      expect(result.verified).toBe(true);
    });
  });

  describe('wallet/create endpoint', () => {
    it('should extract wallet create facts', () => {
      const result = generateVerifiedSummary({
        agentId: 'test-agent',
        summary: 'Create hot wallet',
        permissions: ['wallet:create:hot'],
        action: {
          endpoint: '/wallet/create',
          method: 'POST',
          body: {
            tier: 'hot',
            chain: 'base',
            name: 'Trading Wallet',
          },
        },
      });

      expect(result.action).toBe('/wallet/create');
      expect(result.oneLiner).toContain('hot');
      expect(result.oneLiner).toContain('base');
      expect(result.verified).toBe(true);
    });
  });

  describe('unknown endpoint', () => {
    it('should return raw endpoint and flag warning', () => {
      const result = generateVerifiedSummary({
        agentId: 'test-agent',
        summary: 'Do something custom',
        permissions: ['custom'],
        action: {
          endpoint: '/custom/action',
          method: 'POST',
          body: {},
        },
      });

      expect(result.oneLiner).toContain('/custom/action');
      expect(result.oneLiner).toContain('unverified');
      expect(result.discrepancies.some(d => d.field === 'endpoint' && d.severity === 'warning')).toBe(true);
    });
  });

  describe('missing body fields', () => {
    it('should handle swap with minimal body gracefully', () => {
      const result = generateVerifiedSummary({
        agentId: 'test-agent',
        summary: 'Swap tokens',
        permissions: ['swap'],
        action: {
          endpoint: '/swap',
          method: 'POST',
          body: {},
        },
      });

      expect(result.action).toBe('/swap');
      expect(result.oneLiner).toBeDefined();
      // Should not throw
    });
  });

  describe('no action object', () => {
    it('should generate from permissions/limits only', () => {
      const result = generateVerifiedSummary({
        agentId: 'test-agent',
        summary: 'Request swap access',
        permissions: ['swap'],
        limits: { swap: 0.5 },
        ttl: 300,
      });

      expect(result.oneLiner).toContain('no endpoint');
      expect(result.permissionLabels).toContain('Can swap tokens via DEX');
      expect(result.limitLabels).toEqual([]);
      expect(result.ttlLabel).toBe('5m');
    });
  });

  describe('labels', () => {
    it('should generate permission labels', () => {
      const result = generateVerifiedSummary({
        agentId: 'test-agent',
        summary: 'Test',
        permissions: ['swap', 'send:hot', 'wallet:export'],
        action: { endpoint: '/swap', method: 'POST', body: {} },
      });

      expect(result.permissionLabels).toContain('Can swap tokens via DEX');
      expect(result.permissionLabels).toContain('Can send from hot wallets');
      expect(result.permissionLabels).toContain('Can export private keys');
    });

    it('should not generate limit labels until v2', () => {
      const result = generateVerifiedSummary({
        agentId: 'test-agent',
        summary: 'Test',
        permissions: ['swap'],
        limits: { swap: 0.01, fund: 1.0 },
        action: { endpoint: '/swap', method: 'POST', body: {} },
      });

      expect(result.limitLabels).toEqual([]);
    });

    it('should generate wallet access labels (shortened addresses)', () => {
      const result = generateVerifiedSummary({
        agentId: 'test-agent',
        summary: 'Test',
        permissions: ['swap'],
        walletAccess: ['0x1234567890abcdef1234567890abcdef12345678'],
        action: { endpoint: '/swap', method: 'POST', body: {} },
      });

      expect(result.walletAccessLabels).toEqual(['0x1234...5678']);
    });

    it('should format TTL', () => {
      expect(generateVerifiedSummary({
        agentId: 'a', summary: 's', permissions: [], ttl: 30,
        action: { endpoint: '/swap', method: 'POST', body: {} },
      }).ttlLabel).toBe('30s');

      expect(generateVerifiedSummary({
        agentId: 'a', summary: 's', permissions: [], ttl: 3600,
        action: { endpoint: '/swap', method: 'POST', body: {} },
      }).ttlLabel).toBe('1h');
    });
  });

  describe('generatedAt', () => {
    it('should include ISO timestamp', () => {
      const result = generateVerifiedSummary({
        agentId: 'test-agent',
        summary: 'Test',
        permissions: [],
        action: { endpoint: '/swap', method: 'POST', body: {} },
      });

      expect(() => new Date(result.generatedAt)).not.toThrow();
      expect(new Date(result.generatedAt).getTime()).toBeGreaterThan(0);
    });
  });
});

describe('detectDiscrepancies()', () => {
  it('should detect amount mismatch (critical)', () => {
    const discrepancies = detectDiscrepancies(
      'Swap 0.01 ETH for tokens',
      {
        endpoint: '/swap',
        method: 'POST',
        body: { amount: eth('10'), chain: 'base' },  // 10 ETH, not 0.01
      },
      ['swap'],
    );

    const amountDisc = discrepancies.find(d => d.field === 'amount');
    expect(amountDisc).toBeDefined();
    expect(amountDisc!.severity).toBe('critical');
    expect(amountDisc!.agentClaim).toContain('0.01');
  });

  it('should detect endpoint mismatch (critical)', () => {
    const discrepancies = detectDiscrepancies(
      'Swap tokens on DEX',
      { endpoint: '/send', method: 'POST', body: {} },
      ['send:hot'],
    );

    const endpointDisc = discrepancies.find(d => d.field === 'endpoint' && d.severity === 'critical');
    expect(endpointDisc).toBeDefined();
    expect(endpointDisc!.agentClaim).toBe('swap');
  });

  it('should not flag when summary matches action', () => {
    const discrepancies = detectDiscrepancies(
      'Send 0.1 ETH to wallet',
      {
        endpoint: '/send',
        method: 'POST',
        body: { amount: eth('0.1'), chain: 'base' },
      },
      ['send:hot'],
    );

    const critical = discrepancies.filter(d => d.severity === 'critical');
    expect(critical.length).toBe(0);
  });

  it('should flag raw Solana transaction (info)', () => {
    const discrepancies = detectDiscrepancies(
      'Send 1 SOL',
      {
        endpoint: '/send',
        method: 'POST',
        body: { transaction: 'base64...', chain: 'solana' },
      },
      ['send:hot'],
    );

    const txDisc = discrepancies.find(d => d.field === 'transaction');
    expect(txDisc).toBeDefined();
    expect(txDisc!.severity).toBe('info');
  });

  it('should flag wallet:export permission (warning)', () => {
    const discrepancies = detectDiscrepancies(
      'Export keys',
      { endpoint: '/swap', method: 'POST', body: {} },
      ['swap', 'wallet:export'],
    );

    const exportDisc = discrepancies.find(d => d.field === 'permissions');
    expect(exportDisc).toBeDefined();
    expect(exportDisc!.severity).toBe('warning');
    expect(exportDisc!.actual).toContain('wallet:export');
  });

  it('should flag unknown endpoint (warning)', () => {
    const discrepancies = detectDiscrepancies(
      'Do something',
      { endpoint: '/custom/thing', method: 'POST', body: {} },
      ['custom'],
    );

    const unknownDisc = discrepancies.find(d => d.actual.includes('Unknown endpoint'));
    expect(unknownDisc).toBeDefined();
    expect(unknownDisc!.severity).toBe('warning');
  });

  it('should return empty array for no discrepancies', () => {
    const discrepancies = detectDiscrepancies(
      'Send 0.5 ETH to target',
      {
        endpoint: '/send',
        method: 'POST',
        body: { amount: eth('0.5'), chain: 'base' },
      },
      ['send:hot'],
    );

    const critical = discrepancies.filter(d => d.severity === 'critical');
    expect(critical.length).toBe(0);
  });

  it('should return empty for no action', () => {
    const discrepancies = detectDiscrepancies('Test', undefined, ['swap']);
    expect(discrepancies.length).toBe(0);
  });

  it('should not flag small amount differences within 10%', () => {
    const discrepancies = detectDiscrepancies(
      'Swap 0.01 ETH',
      {
        endpoint: '/swap',
        method: 'POST',
        body: { amount: eth('0.0105'), chain: 'base' },  // 5% diff, within tolerance
      },
      ['swap'],
    );

    const amountDisc = discrepancies.find(d => d.field === 'amount' && d.severity === 'critical');
    expect(amountDisc).toBeUndefined();
  });
});

describe('PERMISSION_LABELS', () => {
  it('should have labels for common permissions', () => {
    expect(PERMISSION_LABELS['swap']).toBeDefined();
    expect(PERMISSION_LABELS['send:hot']).toBeDefined();
    expect(PERMISSION_LABELS['fund']).toBeDefined();
    expect(PERMISSION_LABELS['launch']).toBeDefined();
    expect(PERMISSION_LABELS['wallet:create:hot']).toBeDefined();
    expect(PERMISSION_LABELS['wallet:export']).toBeDefined();
  });
});
