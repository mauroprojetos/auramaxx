import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testPrisma } from '../../setup';
import { createFollow, createPost } from '../../../lib/social/create';
import { syncSocialMessagesNow } from '../../../lib/social/sync';
import { callHubWithSessionAuth, resolveHubAuthIdentity } from '../../../lib/hub-auth';

vi.mock('../../../lib/hub-auth', () => ({
  callHubWithSessionAuth: vi.fn(),
  resolveHubAuthIdentity: vi.fn(),
}));

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_AGENT_ID = 'test-social-sync-agent';
const TEST_AURA_ID = 77;

const callHubWithSessionAuthMock = vi.mocked(callHubWithSessionAuth);
const resolveHubAuthIdentityMock = vi.mocked(resolveHubAuthIdentity);

async function cleanSocialTables() {
  await testPrisma.socialMessage.deleteMany();
  await testPrisma.agentProfile.deleteMany();
}

async function seedAgentProfile() {
  return testPrisma.agentProfile.create({
    data: {
      agentId: TEST_AGENT_ID,
      auraId: TEST_AURA_ID,
    },
  });
}

async function seedPost(text: string) {
  await seedAgentProfile();
  return createPost(TEST_AGENT_ID, TEST_MNEMONIC, text);
}

describe('social/sync', () => {
  beforeEach(async () => {
    await cleanSocialTables();
    vi.clearAllMocks();
    resolveHubAuthIdentityMock.mockReturnValue({ agentId: 'primary', mnemonic: TEST_MNEMONIC });
  });

  it('marks message accepted when hub accepts', async () => {
    const msg = await seedPost('gm');
    callHubWithSessionAuthMock.mockResolvedValue({
      results: [{ hash: msg.hash, status: 'accepted' }],
    });

    await syncSocialMessagesNow({
      messages: [msg],
      transientErrorMode: 'fail',
      prismaClient: testPrisma,
    });

    const updated = await testPrisma.socialMessage.findUnique({ where: { id: msg.id } });
    expect(updated?.syncStatus).toBe('accepted');
    expect(updated?.syncedAt).not.toBeNull();
  });

  it('marks message failed on network error in fail mode', async () => {
    const msg = await seedPost('network failure');
    callHubWithSessionAuthMock.mockRejectedValue(new Error('hub unreachable'));

    await syncSocialMessagesNow({
      messages: [msg],
      transientErrorMode: 'fail',
      prismaClient: testPrisma,
    });

    const updated = await testPrisma.socialMessage.findUnique({ where: { id: msg.id } });
    expect(updated?.syncStatus).toBe('failed');
    expect(updated?.syncCode).toBe('hub_unreachable');
    expect(updated?.attempts).toBe(1);
  });

  it('keeps message pending and sets retry backoff in retry mode', async () => {
    const msg = await seedPost('retry me');
    callHubWithSessionAuthMock.mockRejectedValue(new Error('temporary hub outage'));

    await syncSocialMessagesNow({
      messages: [msg],
      transientErrorMode: 'retry',
      prismaClient: testPrisma,
    });

    const updated = await testPrisma.socialMessage.findUnique({ where: { id: msg.id } });
    expect(updated?.syncStatus).toBe('pending');
    expect(updated?.attempts).toBe(1);
    expect(updated?.nextRetryAt).not.toBeNull();
  });

  it('marks message rejected for permanent hub validation errors', async () => {
    const msg = await seedPost('bad sig');
    callHubWithSessionAuthMock.mockResolvedValue({
      results: [{
        index: 0,
        status: 'invalid_signature',
        code: 'invalid_signature',
        detail: 'signature verification failed',
      }],
    });

    await syncSocialMessagesNow({
      messages: [msg],
      transientErrorMode: 'retry',
      prismaClient: testPrisma,
    });

    const updated = await testPrisma.socialMessage.findUnique({ where: { id: msg.id } });
    expect(updated?.syncStatus).toBe('rejected');
    expect(updated?.syncCode).toBe('invalid_signature');
    expect(updated?.nextRetryAt).toBeNull();
  });

  it('sends sync.submit in envelope format with base64 publicKey', async () => {
    const msg = await seedPost('public key encoding');
    callHubWithSessionAuthMock.mockResolvedValue({
      results: [{ hash: msg.hash, status: 'accepted' }],
    });

    await syncSocialMessagesNow({
      messages: [msg],
      transientErrorMode: 'retry',
      prismaClient: testPrisma,
    });

    expect(callHubWithSessionAuthMock).toHaveBeenCalledTimes(1);

    const [hubUrl, method, payload, mnemonic] = callHubWithSessionAuthMock.mock.calls[0];
    expect(typeof hubUrl).toBe('string');
    expect(method).toBe('sync.submit');
    expect(mnemonic).toBe(TEST_MNEMONIC);

    const typedPayload = payload as {
      publicKey: string;
      messages: Array<{
        data: { type: string; timestamp: number; network: string; body: Record<string, unknown> };
        hashScheme: string;
        signatureScheme: string;
        hash: string;
        signer: string;
        signature: string;
      }>;
    };

    expect(typedPayload.publicKey).toBe(Buffer.from(msg.signer, 'hex').toString('base64'));
    expect(typedPayload.messages).toHaveLength(1);
    expect(typedPayload.messages[0].data.type).toBe(msg.type);
    expect(typedPayload.messages[0].data.timestamp).toBe(msg.timestamp);
    expect(typedPayload.messages[0].hashScheme).toBe('blake3');
    expect(typedPayload.messages[0].signatureScheme).toBe('ed25519');
    expect(typedPayload.messages[0].hash).toBe(msg.hash);
    expect(typedPayload.messages[0].signer).toBe(msg.signer);
    expect(typedPayload.messages[0].signature).toBe(msg.signature);
  });

  it('does not call hub when no unlocked auth identity exists', async () => {
    const msg = await seedPost('no auth identity');
    resolveHubAuthIdentityMock.mockReturnValue(null);

    await syncSocialMessagesNow({
      messages: [msg],
      transientErrorMode: 'fail',
      prismaClient: testPrisma,
    });

    expect(callHubWithSessionAuthMock).not.toHaveBeenCalled();
    const updated = await testPrisma.socialMessage.findUnique({ where: { id: msg.id } });
    expect(updated?.syncStatus).toBe('failed');
    expect(updated?.syncCode).toBe('hub_unreachable');
  });

  it('normalizes followeePublicKey to base64 in sync.submit payload', async () => {
    await seedAgentProfile();
    const followeeHex = 'a'.repeat(64);
    const msg = await createFollow(TEST_AGENT_ID, TEST_MNEMONIC, followeeHex);
    callHubWithSessionAuthMock.mockResolvedValue({
      results: [{ hash: msg.hash, status: 'accepted' }],
    });

    await syncSocialMessagesNow({
      messages: [msg],
      transientErrorMode: 'retry',
      prismaClient: testPrisma,
    });

    expect(callHubWithSessionAuthMock).toHaveBeenCalledTimes(1);
    const [, , payload] = callHubWithSessionAuthMock.mock.calls[0];
    const typedPayload = payload as {
      messages: Array<{ data: { body: Record<string, unknown> } }>;
    };
    expect(typedPayload.messages[0].data.body.followeePublicKey)
      .toBe(Buffer.from(followeeHex, 'hex').toString('base64'));
  });
});
