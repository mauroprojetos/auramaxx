import { describe, it, expect } from 'vitest';
import { parseArgs, resolveRoute } from '../../cli/commands/social';

describe('social CLI command parser', () => {
  it('parses post alias payload', () => {
    const parsed = parseArgs(['post', '--agent-id', 'primary', 'hello', 'world']);
    expect(parsed?.command).toBe('post');
    expect(parsed?.agentId).toBe('primary');
    expect(parsed?.text).toBe('hello world');

    const resolved = resolveRoute(parsed!);
    expect(resolved).toEqual({
      method: 'POST',
      route: '/social/post',
      body: {
        agentId: 'primary',
        text: 'hello world',
      },
    });
  });

  it('maps feed query route', () => {
    const parsed = parseArgs(['feed', '--agent', 'primary', '--limit', '25']);
    const resolved = resolveRoute(parsed!);
    expect(resolved).toEqual({
      method: 'GET',
      route: '/social/feed?agentId=primary&limit=25',
    });
  });

  it('defaults notifications to unread + auto-read', () => {
    const parsed = parseArgs(['notifications', '--agent-id', 'primary']);
    const resolved = resolveRoute(parsed!);
    expect(resolved).toEqual({
      method: 'GET',
      route: '/social/notifications?agentId=primary&unreadOnly=true',
      autoReadNotifications: true,
    });
  });

  it('maps social status route', () => {
    const parsed = parseArgs(['status', '--agent-id', 'primary']);
    const resolved = resolveRoute(parsed!);
    expect(resolved).toEqual({
      method: 'GET',
      route: '/social/status?agentId=primary',
    });
  });

  it('maps register to default hub endpoint', () => {
    const parsed = parseArgs(['register', '--agent-id', 'primary']);
    const resolved = resolveRoute(parsed!);
    expect(resolved).toEqual({
      method: 'POST',
      route: '/agent-hub/primary/register',
    });
  });

  it('maps register + hubUrl to join endpoint', () => {
    const parsed = parseArgs(['register', '--agent-id', 'primary', '--hubUrl', 'https://hub.example']);
    const resolved = resolveRoute(parsed!);
    expect(resolved).toEqual({
      method: 'POST',
      route: '/agent-hub/primary/join',
      body: { hubUrl: 'https://hub.example' },
    });
  });

  it('maps unregister to leave endpoint', () => {
    const parsed = parseArgs(['unregister', '--agent-id', 'primary', '--hubUrl', 'https://hub.example']);
    const resolved = resolveRoute(parsed!);
    expect(resolved).toEqual({
      method: 'POST',
      route: '/agent-hub/primary/leave',
      body: { hubUrl: 'https://hub.example' },
    });
  });

  it('parses agentAddress aliases', () => {
    const parsed = parseArgs(['feed', '--agentAddress', '0xabc']);
    expect(parsed?.agentAddress).toBe('0xabc');
  });
});
