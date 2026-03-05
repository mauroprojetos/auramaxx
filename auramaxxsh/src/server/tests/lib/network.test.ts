/**
 * Tests for SSRF protection utilities in server/lib/network.ts
 *
 * Tests:
 * - isPrivateIp — IPv4 private ranges, IPv6 private ranges, public IPs
 * - resolveAndValidateHost — DNS mocking, private IP blocking
 * - validateExternalUrl — protocol, allowedHosts, DNS-based blocking
 * - sanitizePathSegment — path traversal rejection
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dns before importing network module
vi.mock('dns', () => ({
  default: {
    promises: {
      lookup: vi.fn(),
    },
  },
  promises: {
    lookup: vi.fn(),
  },
}));

import dns from 'dns';
import { isPrivateIp, resolveAndValidateHost, validateExternalUrl, sanitizePathSegment } from '../../lib/network';

describe('Network SSRF Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isPrivateIp()', () => {
    describe('IPv4 private ranges', () => {
      it('should block 127.0.0.0/8 (loopback)', () => {
        expect(isPrivateIp('127.0.0.1')).toBe(true);
        expect(isPrivateIp('127.255.255.255')).toBe(true);
      });

      it('should block 10.0.0.0/8', () => {
        expect(isPrivateIp('10.0.0.1')).toBe(true);
        expect(isPrivateIp('10.255.255.255')).toBe(true);
      });

      it('should block 172.16.0.0/12', () => {
        expect(isPrivateIp('172.16.0.1')).toBe(true);
        expect(isPrivateIp('172.31.255.255')).toBe(true);
      });

      it('should not block 172.15.x.x or 172.32.x.x', () => {
        expect(isPrivateIp('172.15.0.1')).toBe(false);
        expect(isPrivateIp('172.32.0.1')).toBe(false);
      });

      it('should block 192.168.0.0/16', () => {
        expect(isPrivateIp('192.168.1.1')).toBe(true);
        expect(isPrivateIp('192.168.0.1')).toBe(true);
      });

      it('should block 169.254.0.0/16 (link-local / metadata)', () => {
        expect(isPrivateIp('169.254.169.254')).toBe(true);
        expect(isPrivateIp('169.254.0.1')).toBe(true);
      });

      it('should block 0.0.0.0/8', () => {
        expect(isPrivateIp('0.0.0.0')).toBe(true);
        expect(isPrivateIp('0.0.0.1')).toBe(true);
      });
    });

    describe('IPv4 public IPs', () => {
      it('should allow 8.8.8.8', () => {
        expect(isPrivateIp('8.8.8.8')).toBe(false);
      });

      it('should allow 1.1.1.1', () => {
        expect(isPrivateIp('1.1.1.1')).toBe(false);
      });

      it('should allow 104.16.132.229', () => {
        expect(isPrivateIp('104.16.132.229')).toBe(false);
      });
    });

    describe('IPv6 private ranges', () => {
      it('should block ::1 (loopback)', () => {
        expect(isPrivateIp('::1')).toBe(true);
      });

      it('should block ::ffff:127.0.0.1 (IPv4-mapped loopback)', () => {
        expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
      });

      it('should block ::ffff:169.254.169.254 (IPv4-mapped metadata)', () => {
        expect(isPrivateIp('::ffff:169.254.169.254')).toBe(true);
      });

      it('should block ::ffff:10.0.0.1 (IPv4-mapped private)', () => {
        expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
      });

      it('should block fe80::1 (link-local)', () => {
        expect(isPrivateIp('fe80::1')).toBe(true);
      });

      it('should block fd00::1 (unique local)', () => {
        expect(isPrivateIp('fd00::1')).toBe(true);
      });

      it('should block fc00::1 (unique local)', () => {
        expect(isPrivateIp('fc00::1')).toBe(true);
      });
    });

    describe('IPv6 public IPs', () => {
      it('should allow 2001:4860:4860::8888 (Google DNS)', () => {
        expect(isPrivateIp('2001:4860:4860::8888')).toBe(false);
      });
    });

    describe('edge cases', () => {
      it('should return false for non-IP strings', () => {
        expect(isPrivateIp('not-an-ip')).toBe(false);
      });

      it('should return false for empty string', () => {
        expect(isPrivateIp('')).toBe(false);
      });
    });
  });

  describe('resolveAndValidateHost()', () => {
    it('should block hostname resolving to private IP', async () => {
      vi.mocked(dns.promises.lookup).mockResolvedValue({ address: '127.0.0.1', family: 4 });

      await expect(resolveAndValidateHost('evil.com')).rejects.toThrow(
        'resolves to private IP 127.0.0.1',
      );
    });

    it('should allow hostname resolving to public IP', async () => {
      vi.mocked(dns.promises.lookup).mockResolvedValue({ address: '93.184.216.34', family: 4 });

      await expect(resolveAndValidateHost('example.com')).resolves.toBeUndefined();
    });

    it('should block hostname resolving to 169.254.169.254 (metadata)', async () => {
      vi.mocked(dns.promises.lookup).mockResolvedValue({ address: '169.254.169.254', family: 4 });

      await expect(resolveAndValidateHost('metadata.evil.com')).rejects.toThrow('private IP');
    });

    it('should block raw private IPv4 address without DNS lookup', async () => {
      await expect(resolveAndValidateHost('127.0.0.1')).rejects.toThrow('private/reserved IP');
      expect(dns.promises.lookup).not.toHaveBeenCalled();
    });

    it('should allow raw public IPv4 address without DNS lookup', async () => {
      await expect(resolveAndValidateHost('8.8.8.8')).resolves.toBeUndefined();
      expect(dns.promises.lookup).not.toHaveBeenCalled();
    });

    it('should handle DNS lookup failure', async () => {
      vi.mocked(dns.promises.lookup).mockRejectedValue(new Error('ENOTFOUND'));

      await expect(resolveAndValidateHost('nonexistent.invalid')).rejects.toThrow('DNS lookup failed');
    });
  });

  describe('validateExternalUrl()', () => {
    beforeEach(() => {
      // Default: DNS resolves to public IP
      vi.mocked(dns.promises.lookup).mockResolvedValue({ address: '93.184.216.34', family: 4 });
    });

    describe('protocol validation', () => {
      it('should reject file:// protocol', async () => {
        await expect(validateExternalUrl('file:///etc/passwd')).rejects.toThrow('not allowed');
      });

      it('should reject ftp:// protocol', async () => {
        await expect(validateExternalUrl('ftp://files.example.com/data')).rejects.toThrow('not allowed');
      });

      it('should reject gopher:// protocol', async () => {
        await expect(validateExternalUrl('gopher://example.com')).rejects.toThrow('not allowed');
      });

      it('should allow http:// protocol', async () => {
        await expect(validateExternalUrl('http://example.com')).resolves.toBeUndefined();
      });

      it('should allow https:// protocol', async () => {
        await expect(validateExternalUrl('https://example.com')).resolves.toBeUndefined();
      });
    });

    describe('allowedHosts enforcement', () => {
      it('should block unlisted host', async () => {
        await expect(
          validateExternalUrl('https://evil.com/api', ['api.example.com']),
        ).rejects.toThrow('not in the allowed hosts list');
      });

      it('should allow listed host', async () => {
        await expect(
          validateExternalUrl('https://api.example.com/v1/data', ['api.example.com']),
        ).resolves.toBeUndefined();
      });

      it('should skip allowedHosts check when list is empty', async () => {
        await expect(
          validateExternalUrl('https://any-host.com/data', []),
        ).resolves.toBeUndefined();
      });

      it('should skip allowedHosts check when not provided', async () => {
        await expect(
          validateExternalUrl('https://any-host.com/data'),
        ).resolves.toBeUndefined();
      });
    });

    describe('DNS-based SSRF blocking', () => {
      it('should block URL whose hostname resolves to private IP', async () => {
        vi.mocked(dns.promises.lookup).mockResolvedValue({ address: '10.0.0.1', family: 4 });

        await expect(validateExternalUrl('https://evil.com/api')).rejects.toThrow('private IP');
      });

      it('should allow URL whose hostname resolves to public IP', async () => {
        vi.mocked(dns.promises.lookup).mockResolvedValue({ address: '93.184.216.34', family: 4 });

        await expect(validateExternalUrl('https://example.com')).resolves.toBeUndefined();
      });
    });

    describe('invalid URLs', () => {
      it('should reject malformed URL', async () => {
        await expect(validateExternalUrl('not-a-url')).rejects.toThrow('Invalid URL');
      });
    });
  });

  describe('sanitizePathSegment()', () => {
    it('should reject segments with ../', () => {
      expect(() => sanitizePathSegment('../etc/passwd')).toThrow('forbidden characters');
    });

    it('should reject segments with ..', () => {
      expect(() => sanitizePathSegment('foo..bar')).toThrow('forbidden characters');
    });

    it('should reject segments with /', () => {
      expect(() => sanitizePathSegment('foo/bar')).toThrow('forbidden characters');
    });

    it('should reject segments with backslash', () => {
      expect(() => sanitizePathSegment('foo\\bar')).toThrow('forbidden characters');
    });

    it('should allow normal app IDs', () => {
      expect(sanitizePathSegment('my-app')).toBe('my-app');
      expect(sanitizePathSegment('strategy_123')).toBe('strategy_123');
      expect(sanitizePathSegment('tic-tac-toe')).toBe('tic-tac-toe');
    });

    it('should allow IDs with dots (not ..)', () => {
      expect(sanitizePathSegment('v1.2.3')).toBe('v1.2.3');
    });

    it('should return the segment unchanged', () => {
      const id = 'my-strategy';
      expect(sanitizePathSegment(id)).toBe(id);
    });
  });
});
