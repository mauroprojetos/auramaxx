import { describe, it, expect, beforeEach } from 'vitest';
import { testPrisma } from '../../setup';
import {
  createPost,
  createReaction,
  createFollow,
  createUnfollow,
  createProfileUpdate,
} from '../../../lib/social/create';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake3 } from '@noble/hashes/blake3.js';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_AGENT_ID = 'test-social-agent';
const TEST_AURA_ID = 42;

async function cleanSocialTables() {
  await testPrisma.socialMessage.deleteMany();
  await testPrisma.agentProfile.deleteMany();
}

async function seedAgentProfile(auraId: number | null = TEST_AURA_ID) {
  return testPrisma.agentProfile.create({
    data: {
      agentId: TEST_AGENT_ID,
      auraId,
    },
  });
}

describe('social/create', () => {
  beforeEach(async () => {
    await cleanSocialTables();
  });

  describe('createPost()', () => {
    it('should create a post_add message with pending syncStatus', async () => {
      await seedAgentProfile();

      const msg = await createPost(TEST_AGENT_ID, TEST_MNEMONIC, 'gm auramaxxnow');

      expect(msg.agentId).toBe(TEST_AGENT_ID);
      expect(msg.type).toBe('post_add');
      expect(msg.syncStatus).toBe('pending');
      expect(msg.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(msg.signature).toMatch(/^[0-9a-f]{128}$/);
      expect(msg.signer).toMatch(/^[0-9a-f]{64}$/);

      const body = JSON.parse(msg.body);
      expect(body.text).toBe('gm auramaxxnow');
    });

    it('should include optional fields in body', async () => {
      await seedAgentProfile();

      const msg = await createPost(TEST_AGENT_ID, TEST_MNEMONIC, 'hello', {
        embeds: ['https://example.com'],
        parentPostHash: 'abc123',
        mentions: [7, 11],
      });

      const body = JSON.parse(msg.body);
      expect(body.text).toBe('hello');
      expect(body.embeds).toEqual(['https://example.com']);
      expect(body.parentPostHash).toBe('abc123');
      expect(body.mentions).toEqual([7, 11]);
    });

    it('should omit empty optional fields', async () => {
      await seedAgentProfile();

      const msg = await createPost(TEST_AGENT_ID, TEST_MNEMONIC, 'simple post');

      const body = JSON.parse(msg.body);
      expect(body).toEqual({ text: 'simple post' });
      expect(body.embeds).toBeUndefined();
      expect(body.parentPostHash).toBeUndefined();
      expect(body.mentions).toBeUndefined();
    });

    it('should produce a verifiable signature', async () => {
      await seedAgentProfile();

      const msg = await createPost(TEST_AGENT_ID, TEST_MNEMONIC, 'verify me');

      const hashBytes = Buffer.from(msg.hash, 'hex');
      const sigBytes = Buffer.from(msg.signature, 'hex');
      const pubBytes = Buffer.from(msg.signer, 'hex');
      expect(ed25519.verify(sigBytes, hashBytes, pubBytes)).toBe(true);
    });
  });

  describe('createReaction()', () => {
    it('should create a reaction_add message', async () => {
      await seedAgentProfile();

      const msg = await createReaction(TEST_AGENT_ID, TEST_MNEMONIC, 'abc123', 'like');

      expect(msg.type).toBe('reaction_add');
      const body = JSON.parse(msg.body);
      expect(body.postHash).toBe('abc123');
      expect(body.reactionType).toBe('like');
    });
  });

  describe('createFollow()', () => {
    it('should create a link_add message', async () => {
      await seedAgentProfile();

      const targetPubKey = 'ab'.repeat(32);
      const msg = await createFollow(TEST_AGENT_ID, TEST_MNEMONIC, targetPubKey);

      expect(msg.type).toBe('link_add');
      const body = JSON.parse(msg.body);
      expect(body.followeePublicKey).toBe(targetPubKey);
      expect(body.linkType).toBe('follow');
    });
  });

  describe('createUnfollow()', () => {
    it('should create a link_remove message', async () => {
      await seedAgentProfile();

      const targetPubKey = 'ab'.repeat(32);
      const msg = await createUnfollow(TEST_AGENT_ID, TEST_MNEMONIC, targetPubKey);

      expect(msg.type).toBe('link_remove');
      const body = JSON.parse(msg.body);
      expect(body.followeePublicKey).toBe(targetPubKey);
      expect(body.linkType).toBe('follow');
    });
  });

  describe('createProfileUpdate()', () => {
    it('should create a user_data_add message', async () => {
      await seedAgentProfile();

      const msg = await createProfileUpdate(
        TEST_AGENT_ID,
        TEST_MNEMONIC,
        'display',
        'Agent Smith',
      );

      expect(msg.type).toBe('user_data_add');
      const body = JSON.parse(msg.body);
      expect(body.type).toBe('display');
      expect(body.value).toBe('Agent Smith');
    });
  });

  describe('error handling', () => {
    it('should throw if agent has no auraId', async () => {
      await seedAgentProfile(null);

      await expect(
        createPost(TEST_AGENT_ID, TEST_MNEMONIC, 'should fail'),
      ).rejects.toThrow('no auraId');
    });

    it('should throw if agent profile does not exist', async () => {
      await expect(
        createPost('nonexistent-agent', TEST_MNEMONIC, 'should fail'),
      ).rejects.toThrow('no auraId');
    });
  });

  describe('persistence', () => {
    it('should persist the message in SocialMessage table', async () => {
      await seedAgentProfile();

      const msg = await createPost(TEST_AGENT_ID, TEST_MNEMONIC, 'persisted');

      const found = await testPrisma.socialMessage.findUnique({
        where: { hash: msg.hash },
      });
      expect(found).not.toBeNull();
      expect(found!.agentId).toBe(TEST_AGENT_ID);
      expect(found!.syncStatus).toBe('pending');
    });

    it('should reject duplicate hashes', async () => {
      await seedAgentProfile();

      // Two messages with same content at same timestamp would produce same hash.
      // In practice timestamps differ, but we test the unique constraint.
      const msg = await createPost(TEST_AGENT_ID, TEST_MNEMONIC, 'first');

      // Force a duplicate by inserting directly
      await expect(
        testPrisma.socialMessage.create({
          data: {
            agentId: msg.agentId,
            hash: msg.hash, // duplicate
            type: msg.type,
            body: msg.body,
            timestamp: msg.timestamp,
            network: msg.network,
            signature: msg.signature,
            signer: msg.signer,
          },
        }),
      ).rejects.toThrow();
    });
  });
});
