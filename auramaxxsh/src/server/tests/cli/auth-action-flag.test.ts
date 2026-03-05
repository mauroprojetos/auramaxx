/**
 * Tests for CLI auth request --action flag parsing
 */
import { describe, it, expect } from 'vitest';
import { _testOnly } from '../../cli/commands/auth';

const { parseActionFlag, parseRequestFlags, buildPollUrl } = _testOnly;

describe('CLI auth --action flag parsing', () => {
  describe('parseActionFlag', () => {
    it('returns undefined when --action not present', () => {
      expect(parseActionFlag(['--profile', 'strict'])).toBeUndefined();
    });

    it('parses valid JSON action with endpoint, method, and body', () => {
      const args = ['--action', '{"endpoint":"/send","method":"POST","body":{"to":"0x123","amount":"0.01"}}'];
      const result = parseActionFlag(args);
      expect(result).toEqual({
        endpoint: '/send',
        method: 'POST',
        body: { to: '0x123', amount: '0.01' },
      });
    });

    it('parses action without body', () => {
      const args = ['--action', '{"endpoint":"/wallets","method":"GET"}'];
      const result = parseActionFlag(args);
      expect(result).toEqual({
        endpoint: '/wallets',
        method: 'GET',
      });
    });

    it('normalizes method to uppercase', () => {
      const args = ['--action', '{"endpoint":"/wallets","method":"get"}'];
      const result = parseActionFlag(args);
      expect(result!.method).toBe('GET');
    });

    it('throws on invalid JSON', () => {
      const args = ['--action', 'not-json'];
      expect(() => parseActionFlag(args)).toThrow();
    });

    it('throws when JSON is not an object', () => {
      const args = ['--action', '"just-a-string"'];
      expect(() => parseActionFlag(args)).toThrow('--action must be a JSON object');
    });

    it('throws when JSON is an array', () => {
      const args = ['--action', '[1,2,3]'];
      expect(() => parseActionFlag(args)).toThrow('--action must be a JSON object');
    });

    it('throws when endpoint is missing', () => {
      const args = ['--action', '{"method":"POST"}'];
      expect(() => parseActionFlag(args)).toThrow('--action requires "endpoint"');
    });

    it('throws when method is missing', () => {
      const args = ['--action', '{"endpoint":"/send"}'];
      expect(() => parseActionFlag(args)).toThrow('--action requires "endpoint" (string) and "method" (string)');
    });

    it('ignores body when it is an array', () => {
      const args = ['--action', '{"endpoint":"/send","method":"POST","body":[1,2]}'];
      const result = parseActionFlag(args);
      expect(result).toEqual({
        endpoint: '/send',
        method: 'POST',
      });
    });
  });

  describe('parseRequestFlags', () => {
    it('includes action in parsed request flags', () => {
      const args = [
        '--agent-id', 'test-cli',
        '--profile', 'dev',
        '--action', '{"endpoint":"/swap","method":"POST","body":{"from":"ETH","to":"USDC"}}',
      ];
      const parsed = parseRequestFlags(args);
      expect(parsed.agentId).toBe('test-cli');
      expect(parsed.profile).toBe('dev');
      expect(parsed.action).toEqual({
        endpoint: '/swap',
        method: 'POST',
        body: { from: 'ETH', to: 'USDC' },
      });
    });

    it('defaults request mode to no-wait (approve -> claim -> retry)', () => {
      const parsed = parseRequestFlags(['--agent-id', 'test-cli', '--profile', 'strict']);
      expect(parsed.noWait).toBe(true);
    });

    it('leaves profile/version unset when omitted (resolved later from defaults)', () => {
      const parsed = parseRequestFlags(['--agent-id', 'test-cli']);
      expect(parsed.profile).toBeUndefined();
      expect(parsed.profileVersion).toBeUndefined();
    });

    it('supports explicit --wait legacy mode', () => {
      const parsed = parseRequestFlags(['--agent-id', 'test-cli', '--profile', 'strict', '--wait']);
      expect(parsed.noWait).toBe(false);
    });

    it('throws when both --wait and --no-wait are provided', () => {
      expect(() => parseRequestFlags([
        '--agent-id', 'test-cli',
        '--profile', 'strict',
        '--wait',
        '--no-wait',
      ])).toThrow('Use only one of --wait or --no-wait');
    });

    it('action is undefined when flag not provided', () => {
      const args = ['--agent-id', 'test-cli', '--profile', 'strict'];
      const parsed = parseRequestFlags(args);
      expect(parsed.action).toBeUndefined();
    });
  });

  describe('buildPollUrl', () => {
    it('builds poll URL from requestId + secret', () => {
      const pollUrl = buildPollUrl('http://127.0.0.1:4242', 'req-123', 'sec-123');
      expect(pollUrl).toBe('http://127.0.0.1:4242/auth/req-123');
    });

    it('encodes reserved characters in requestId and secret', () => {
      const pollUrl = buildPollUrl('http://localhost:4242/', 'req/123', 'sec?=x&y');
      expect(pollUrl).toBe('http://localhost:4242/auth/req%2F123');
    });
  });
});
