import { describe, expect, it } from 'vitest';
import {
  AUTH_EXIT_CODES,
  AUTH_REMEDIATION_SCHEMA_VERSION,
  CONFORMANCE_MAX_AGE_MS,
  ERROR_BUDGET_HOLD_DWELL_MS,
  MAX_ACTIVE_EXCEPTIONS_PER_SCOPE,
  MAX_FAILED_EPISODES_PER_HOUR,
  MAX_ROTATION_GRACE_SECONDS,
  SIGNER_ROTATION_OVERLAP_MS,
  WAIVER_SCHEMA_VERSION,
  PAIRING_MAX_TTL_MS,
  PAIRING_MIN_BITS,
  applyRotationGraceSeconds,
  assertNoAgentIdCollision,
  assertNoRedirectStatus,
  assertPairingUsable,
  assertResetConfirmation,
  assertSupportedRemediationSchema,
  attemptLeaseTakeover,
  canonicalizeAgentIdentity,
  cooldownWithDeterministicJitterSeconds,
  enforceRotationOverlapInvariant,
  evaluateLocalTrustProofSequence,
  hasCoverageForEnforce,
  canonicalizeDriftFamilies,
  hasPromotionSampleFloor,
  generatePairingCode,
  isResetRateLimited,
  leaseStaleReason,
  legacyKeychainAliases,
  matchesRevocationScope,
  nextBackoffSeconds,
  nextHeadlessRenewalWindow,
  reconcileDriftObservations,
  redactSensitiveText,
  resolveErrorBudgetGovernance,
  refreshAtMs,
  resolveCapabilityNegotiation,
  resolveProviderOrder,
  resolveRefreshState,
  resolveRotationOutcome,
  resolveTransferCommit,
  resolveUnknownMajorSchemaOutcome,
  sanitizeRegisterTelemetryEvent,
  toAuthErrorEnvelope,
  toAuthRemediationPayload,
  toCanonicalKeychainKey,
  validateBreakGlassRequest,
  validateConformanceArtifact,
  validateExceptionComposition,
  validateForensicsSigner,
  validatePairingCodeShape,
  validateRemoteBootstrapEndpoint,
  validateWaiverArtifact,
  DELEGATION_MAX_SKEW_MS,
  CRYPTO_PHASE_MATRIX,
  canonicalizeDelegationBinding,
  evaluateApprovalSet,
  evaluateComplianceClosure,
  resolveCausalConflictPrecedence,
  resolveDelegationRevocationPrecedence,
  validateCryptoPhaseState,
  validateCryptoRollback,
  validatePartitionJournalChain,
  isDelegationExpired,
} from '../../../lib/agent-auth/contracts';

describe('agent auth contracts', () => {
  it('resolves deterministic provider order by runtime mode', () => {
    expect(resolveProviderOrder('interactive_local')).toEqual([
      'in_memory',
      'unix_socket',
      'keychain',
      'env',
      'interactive_auth',
      'pairing',
    ]);
    expect(resolveProviderOrder('headless_local')).toEqual([
      'in_memory',
      'unix_socket',
      'keychain',
      'env',
      'pairing',
    ]);
    expect(resolveProviderOrder('remote')).toEqual([
      'in_memory',
      'keychain',
      'env',
      'pairing',
    ]);
  });

  it('forms canonical keychain keys and supports legacy aliases', () => {
    const key = toCanonicalKeychainKey('Dev Profile', 'MCP Agent', 'READ');
    expect(key).toBe('auramaxx:dev-profile:mcp-agent:read');
    expect(legacyKeychainAliases('Dev Profile', 'MCP Agent')).toEqual([
      'aura:dev-profile:mcp-agent',
      'auramaxx:dev-profile:mcp-agent',
    ]);
    expect(() => toCanonicalKeychainKey('x'.repeat(33), 'agent', 'read')).toThrow('CONFIG');
  });

  it('enforces refresh scheduling and terminal semantics', () => {
    const now = 1_000_000;
    const exp = now + 120_000;
    expect(refreshAtMs(exp, now, 0)).toBe(exp - 60_000);
    expect(nextBackoffSeconds(0)).toBe(2);
    expect(nextBackoffSeconds(4)).toBe(32);
    expect(nextBackoffSeconds(99)).toBe(120);

    expect(resolveRefreshState('DENIED', now, exp)).toBe('needs_reauth');
    expect(resolveRefreshState('NETWORK', now, exp)).toBe('active');
    expect(resolveRefreshState('NETWORK', exp + 1, exp)).toBe('needs_reauth');
  });

  it('enforces pairing-code shape and abuse guardrails', () => {
    const code = generatePairingCode();
    expect(validatePairingCodeShape(code)).toBe(true);
    expect(PAIRING_MIN_BITS).toBeGreaterThanOrEqual(80);
    expect(PAIRING_MAX_TTL_MS).toBe(300000);

    const now = Date.now();
    expect(assertPairingUsable({
      pairingId: 'p1', issuedAt: now, nonce: 'n', ttlMs: PAIRING_MAX_TTL_MS,
      failedAttempts: 0, sourceFailedAttempts: 0,
    }, now)).toBeNull();

    expect(assertPairingUsable({
      pairingId: 'p2', issuedAt: now - PAIRING_MAX_TTL_MS - 1, nonce: 'n', ttlMs: PAIRING_MAX_TTL_MS,
      failedAttempts: 0, sourceFailedAttempts: 0,
    }, now)).toBe('PAIRING_EXPIRED');

    expect(assertPairingUsable({
      pairingId: 'p3', issuedAt: now, consumedAt: now, nonce: 'n', ttlMs: PAIRING_MAX_TTL_MS,
      failedAttempts: 0, sourceFailedAttempts: 0,
    }, now)).toBe('PAIRING_CONSUMED');

    expect(assertPairingUsable({
      pairingId: 'p4', issuedAt: now, nonce: 'n', ttlMs: PAIRING_MAX_TTL_MS,
      failedAttempts: 5, sourceFailedAttempts: 0,
    }, now)).toBe('PAIRING_ATTEMPTS_EXCEEDED');

    expect(assertPairingUsable({
      pairingId: 'p5', issuedAt: now, nonce: 'n', ttlMs: PAIRING_MAX_TTL_MS,
      failedAttempts: 0, sourceFailedAttempts: 20,
    }, now)).toBe('PAIRING_ATTEMPTS_EXCEEDED');

    expect(assertPairingUsable({
      pairingId: 'p6', issuedAt: now, nonce: 'n', ttlMs: PAIRING_MAX_TTL_MS,
      failedAttempts: 0, sourceFailedAttempts: 0, sourceLockUntil: now + 60_000,
    }, now)).toBe('PAIRING_LOCKED');
  });

  it('matches revocation scope without overreach', () => {
    const row = {
      tokenId: 't',
      pairingId: 'pair-1',
      agentId: 'agent-1',
      pubkeyFingerprint: 'fp-1',
      issuedAt: Date.now(),
    };

    expect(matchesRevocationScope(row, 'pairing', 'pair-1')).toBe(true);
    expect(matchesRevocationScope(row, 'pairing', 'pair-2')).toBe(false);
    expect(matchesRevocationScope(row, 'agent_identity', 'agent-1')).toBe(true);
    expect(matchesRevocationScope(row, 'fingerprint', 'fp-1')).toBe(true);
  });

  it('redacts deterministic token-like patterns and preserves safe identifiers', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature';
    const blob = 'A'.repeat(120);
    const mixed = `token=${jwt} blob=${blob} email=alice@example.com url=https://example.com/x`;
    const { redacted, buckets } = redactSensitiveText(mixed);

    expect(redacted).toContain('[REDACTED:jwt]');
    expect(redacted).toContain('[REDACTED:blob]');
    expect(redacted).toContain('alice@example.com');
    expect(redacted).toContain('https://example.com/x');
    expect(redacted).not.toContain(jwt);
    expect(redacted).not.toContain(blob);
    expect(buckets.length).toBeGreaterThanOrEqual(2);
  });

  it('canonicalizes agent identity and hard-fails collisions deterministically', () => {
    const canonical = canonicalizeAgentIdentity(' Aura   MCP 🚀 ', 'Dev Profile');
    expect(canonical.agentId).toBe('agent:aura-mcp:dev-profile');

    expect(() => assertNoAgentIdCollision(canonical, null)).not.toThrow();
    expect(() => assertNoAgentIdCollision(canonical, {
      createdAt: '2026-02-17T00:00:00.000Z',
      fingerprintPrefix: 'abc12345',
    })).toThrow('ID_COLLISION');
  });

  it('enforces strict remote endpoint transport, allowlist and redirect block', () => {
    expect(validateRemoteBootstrapEndpoint('https://api.example.com/bootstrap', {
      allowlistOrigins: ['https://api.example.com'],
    })).toEqual({ origin: 'https://api.example.com:443' });

    expect(() => validateRemoteBootstrapEndpoint('http://api.example.com/bootstrap')).toThrow('NETWORK_TLS');
    expect(() => validateRemoteBootstrapEndpoint('http://localhost:3000/bootstrap')).toThrow('NETWORK_TLS');

    expect(validateRemoteBootstrapEndpoint('http://localhost:3000/bootstrap', {
      allowInsecureLocalHttp: true,
      allowlistOrigins: ['http://localhost:3000'],
    })).toEqual({ origin: 'http://localhost:3000' });

    expect(() => validateRemoteBootstrapEndpoint('https://10.0.0.2/bootstrap')).toThrow('REMOTE_ALLOWLIST_DENY');
    expect(() => assertNoRedirectStatus(302)).toThrow('REMOTE_REDIRECT_BLOCKED');
  });

  it('requires explicit reset confirmation and enforces reset rate limits', () => {
    expect(() => assertResetConfirmation({
      interactive: true,
      resetIdentity: true,
      agentId: 'agent:aura:dev',
      typedConfirmation: 'RESET agent:aura:dev',
    })).not.toThrow();

    expect(() => assertResetConfirmation({
      interactive: false,
      resetIdentity: true,
      agentId: 'agent:aura:dev',
      confirmResetAgentId: 'agent:aura:other',
    })).toThrow('RESET_CONFIRM_REQUIRED');

    const now = Date.now();
    expect(isResetRateLimited([now - 1000, now - 2000], now)).toBe(false);
    expect(isResetRateLimited([now - 1000, now - 2000, now - 3000], now)).toBe(true);
  });

  it('builds stable v1 auth error envelopes and sanitizes register telemetry', () => {
    const err = toAuthErrorEnvelope({
      family: 'network',
      subcode: 'NETWORK_TLS',
      message: 'TLS required',
    });
    expect(err.authErrorSchemaVersion).toBe('v1');
    expect(err.exitCode).toBe(AUTH_EXIT_CODES.NETWORK_TLS);

    const telemetry = sanitizeRegisterTelemetryEvent({
      event: 'auth.register.failed',
      timestamp: new Date().toISOString(),
      agentId: 'agent:aura:dev',
      profile: 'dev',
      scope: 'read',
      authMode: 'remote',
      attempt: 1,
      durationMs: 250,
      result: 'failure',
      failureFamily: 'network',
      failureSubcode: 'NETWORK_TLS',
      persistenceBackend: 'memory',
      providerPath: ['in_memory', 'pairing'],
      correlationId: 'corr-1',
      fingerprintPrefix: '1234567890abcdef',
      endpointOrigin: 'https://api.example.com/path?secret=yes',
    });

    expect(telemetry.fingerprintPrefix).toBe('12345678');
    expect(telemetry.endpointOrigin).toBe('https://api.example.com');
  });

  it('enforces rotation grace cap and truth-table outcomes', () => {
    expect(applyRotationGraceSeconds()).toBe(30);
    expect(() => applyRotationGraceSeconds(MAX_ROTATION_GRACE_SECONDS + 1)).toThrow('CONFIG');

    const withinCap = enforceRotationOverlapInvariant({
      cutoverStartedAtMs: 1_000,
      nowMs: 1_000 + 119_000,
      graceSeconds: 120,
    });
    expect(withinCap.overlapInvariantSatisfied).toBe(true);
    expect(withinCap.forceExpireOldToken).toBe(false);

    const exceeded = enforceRotationOverlapInvariant({
      cutoverStartedAtMs: 1_000,
      nowMs: 1_000 + 121_000,
      graceSeconds: 120,
    });
    expect(exceeded.overlapInvariantSatisfied).toBe(false);
    expect(exceeded.forceExpireOldToken).toBe(true);

    expect(resolveRotationOutcome('REVOKE_SUCCESS')).toEqual({
      oldValid: false,
      newValid: true,
      terminalState: 'ACTIVE',
      subcode: 'ROTATE_SUCCESS',
    });
    expect(resolveRotationOutcome('ROLLBACK_FAIL')).toEqual({
      oldValid: false,
      newValid: false,
      terminalState: 'NEEDS_REAUTH',
      subcode: 'ROTATE_ROLLBACK_FAILED',
    });
  });

  it('enforces headless cooldown jitter and episode escalation limits', () => {
    const first = cooldownWithDeterministicJitterSeconds('agent:aura:dev', 60);
    const again = cooldownWithDeterministicJitterSeconds('agent:aura:dev', 60);
    expect(first).toBe(again);

    const nowMs = Date.now();
    const escalated = {
      state: 'NEEDS_REAUTH',
      subcode: 'REAUTH_EPISODE_LIMIT_EXCEEDED',
    };
    const overLimit = MAX_FAILED_EPISODES_PER_HOUR + 1;
    const window = nextHeadlessRenewalWindow({
      agentId: 'agent:aura:dev',
      nowMs,
      failedEpisodesLastHour: overLimit,
      consecutiveFailedEpisodes: 5,
    });
    expect(window.state).toBe(escalated.state);
    expect(window.subcode).toBe(escalated.subcode);
    expect(window.nextAllowedAttemptAt).not.toBeNull();
  });

  it('supports stale lease detection and CAS takeover', () => {
    const now = Date.now();
    const stale = leaseStaleReason({
      ownerId: 'owner-a',
      leaseVersion: 4,
      acquiredAtMs: now - 60_000,
      lastRenewedAtMs: now - 46_000,
      heartbeatMisses: 2,
      ownerProofFailures: 0,
    }, now);
    expect(stale).toBe('HEARTBEAT_TIMEOUT');

    const takeover = attemptLeaseTakeover({
      currentLease: {
        ownerId: 'owner-a',
        leaseVersion: 4,
        acquiredAtMs: now - 60_000,
        lastRenewedAtMs: now - 46_000,
        heartbeatMisses: 2,
        ownerProofFailures: 0,
      },
      expectedLeaseVersion: 4,
      contenderOwnerId: 'owner-b',
      nowMs: now,
    });
    expect(takeover.takeoverSucceeded).toBe(true);
    expect(takeover.newLease?.ownerId).toBe('owner-b');

    const failed = attemptLeaseTakeover({
      currentLease: takeover.newLease!,
      expectedLeaseVersion: 4,
      contenderOwnerId: 'owner-c',
      nowMs: now,
    });
    expect(failed.takeoverSucceeded).toBe(false);
  });

  it('builds remediation payload fallback and enforces schema compatibility', () => {
    const known = toAuthRemediationPayload('NETWORK_TLS', null);
    expect(known.authRemediationSchemaVersion).toBe(AUTH_REMEDIATION_SCHEMA_VERSION);
    expect(known.recommendedAction).toBe('verify_tls_configuration');

    const unknown = toAuthRemediationPayload('SOMETHING_NEW', null);
    expect(unknown.recommendedAction).toBe('inspect_auth_logs');

    expect(() => assertSupportedRemediationSchema('v1')).not.toThrow();
    expect(() => assertSupportedRemediationSchema('v2')).toThrow('REMEDIATION_SCHEMA_UNSUPPORTED');
  });

  it('enforces TOCTOU-safe local trust proof sequence and compatible warnings', () => {
    const compatible = evaluateLocalTrustProofSequence({
      policyMode: 'compatible',
      accepted: { uid: 501, pid: 1001, exePathPolicy: 'warn', exeHashPolicy: 'pass' },
      issueCheck: { uid: 501, pid: 1001, exePathPolicy: 'warn', exeHashPolicy: 'pass' },
    });
    expect(compatible.trustDecision).toBe('allow_with_warning');

    const strict = evaluateLocalTrustProofSequence({
      policyMode: 'strict',
      accepted: { uid: 501, pid: 1001, exePathPolicy: 'pass', exeHashPolicy: 'pass' },
      issueCheck: { uid: 501, pid: 1001, exePathPolicy: 'pass', exeHashPolicy: 'pass' },
    });
    expect(strict.trustDecision).toBe('allow');

    expect(() => evaluateLocalTrustProofSequence({
      policyMode: 'strict',
      accepted: { uid: 501, pid: 1001, exePathPolicy: 'pass', exeHashPolicy: 'pass' },
      issueCheck: { uid: 501, pid: 1002, exePathPolicy: 'pass', exeHashPolicy: 'pass' },
    })).toThrow('LOCAL_TRUST_PROOF_CHANGED');
  });

  it('enforces rollout capability negotiation semantics across modes', () => {
    const registry = {
      trust_proof_v1: {
        capabilityKey: 'trust_proof_v1',
        criticality: 'critical' as const,
        owner: 'auth',
        introducedInContractVersion: 'v1',
        lastModifiedAt: new Date().toISOString(),
        registryVersion: '2026.02.17',
      },
      telemetry_v1: {
        capabilityKey: 'telemetry_v1',
        criticality: 'non_critical' as const,
        owner: 'auth',
        introducedInContractVersion: 'v1',
        lastModifiedAt: new Date().toISOString(),
        registryVersion: '2026.02.17',
      },
    };

    const serverMissing = resolveCapabilityNegotiation({
      policyMode: 'observe',
      requiredCaps: ['trust_proof_v1'],
      clientCaps: ['trust_proof_v1'],
      serverCaps: [],
      registry,
    });
    expect(serverMissing.allowed).toBe(false);
    expect(serverMissing.subcode).toBe('SERVER_CAPABILITY_MISSING');

    const warnNonCritical = resolveCapabilityNegotiation({
      policyMode: 'warn',
      requiredCaps: ['telemetry_v1'],
      clientCaps: [],
      serverCaps: ['telemetry_v1'],
      registry,
    });
    expect(warnNonCritical.allowed).toBe(true);
    expect(warnNonCritical.subcode).toBe('CAPABILITY_MISMATCH_WARN');

    const enforceMismatch = resolveCapabilityNegotiation({
      policyMode: 'enforce',
      requiredCaps: ['telemetry_v1'],
      clientCaps: [],
      serverCaps: ['telemetry_v1'],
      registry,
    });
    expect(enforceMismatch.allowed).toBe(false);
    expect(enforceMismatch.subcode).toBe('CAPABILITY_MISMATCH');
  });

  it('enforces rollout promotion floors, coverage floors, break-glass rules, and stale conformance rejection', () => {
    expect(hasPromotionSampleFloor({
      transition: 'observe_to_warn',
      handshakeSamples: 9999,
      distinctAgents: 50,
      distinctProfiles: 3,
    })).toEqual({ pass: false, subcode: 'PROMOTION_INSUFFICIENT_SAMPLE' });

    expect(hasPromotionSampleFloor({
      transition: 'warn_to_enforce',
      handshakeSamples: 50000,
      distinctAgents: 200,
      distinctProfiles: 5,
    })).toEqual({ pass: true, subcode: null });

    expect(hasCoverageForEnforce({ capabilityDecision: 99, requiredCaps: 99, wouldBlock: 99.4 })).toEqual({
      pass: false,
      subcode: 'PROMOTION_COVERAGE_INCOMPLETE',
    });

    expect(() => validateBreakGlassRequest({
      scope: { environment: 'prod', region: 'us-west-2' },
      affectedAgents: 250,
      activeFleetAgents: 1000,
      approvals: 1,
      ttlMs: 30 * 60_000,
    })).toThrow('BREAK_GLASS_APPROVAL_REQUIRED');

    const now = Date.now();
    expect(validateConformanceArtifact({
      generatedAtMs: now - CONFORMANCE_MAX_AGE_MS - 1,
      nowMs: now,
      currentServerBuild: 'build-A',
      artifactServerBuild: 'build-A',
      currentRegistryVersion: '2026.02.17',
      artifactRegistryVersion: '2026.02.17',
    })).toEqual({ pass: false, subcode: 'PROMOTION_CONFORMANCE_STALE' });
  });

  it('pins unknown-major schema behavior by mode and enforce-hold state', () => {
    const warn = resolveUnknownMajorSchemaOutcome({
      policyMode: 'warn',
      unresolvedSamples: 1,
      currentlyEnforced: false,
    });
    expect(warn.allowOperation).toBe(true);
    expect(warn.promotionBlocked).toBe(true);
    expect(warn.subcode).toBe('SCHEMA_MAJOR_UNKNOWN');

    const enforce = resolveUnknownMajorSchemaOutcome({
      policyMode: 'enforce',
      unresolvedSamples: 2,
      currentlyEnforced: true,
    });
    expect(enforce.allowOperation).toBe(false);
    expect(enforce.enforceHold).toBe(true);
    expect(enforce.subcode).toBe('SCHEMA_MAJOR_UNKNOWN_ENFORCED');
  });

  it('reconciles drift families deterministically under out-of-order arrivals', () => {
    const canonical = canonicalizeDriftFamilies([
      'runtime_capability',
      'transport_tls',
      'runtime_capability',
      'socket_identity',
    ]);
    expect(canonical).toEqual(['transport_tls', 'socket_identity', 'runtime_capability']);

    const reconciled = reconcileDriftObservations([
      { family: 'policy_integrity', detectedAtMs: 3000, seq: 2 },
      { family: 'transport_tls', detectedAtMs: 1000, seq: 5 },
      { family: 'identity_fingerprint', detectedAtMs: 2000, seq: 1 },
    ]);
    expect(reconciled.driftReconciled).toBe(true);
    expect(reconciled.order).toEqual(['transport_tls', 'identity_fingerprint', 'policy_integrity']);
  });

  it('enforces commit linearization semantics for cross-host transfer', () => {
    expect(resolveTransferCommit({
      phase: 'commit',
      transferId: 'tx-1',
      expectedCommitIndex: 41,
      observedCommitIndex: 41,
    }).subcode).toBe('TRANSFER_COMMIT_APPLIED');

    expect(resolveTransferCommit({
      phase: 'finalize',
      transferId: 'tx-1',
      expectedCommitIndex: 41,
      observedCommitIndex: 42,
    }).subcode).toBe('TRANSFER_COMMIT_ALREADY_APPLIED');

    const conflict = resolveTransferCommit({
      phase: 'commit',
      transferId: 'tx-2',
      expectedCommitIndex: 50,
      observedCommitIndex: 49,
    });
    expect(conflict.finalStateKnown).toBe(false);
    expect(conflict.subcode).toBe('TRANSFER_COMMIT_CONFLICT');
  });

  it('enforces exception overlap invariant protection and active limits', () => {
    expect(validateExceptionComposition({
      scopeKey: 'prod/us-west',
      activeExceptionCount: MAX_ACTIVE_EXCEPTIONS_PER_SCOPE,
      overlays: ['allow_background_refresh'],
      requestedRelaxations: ['allow_background_refresh'],
      protectedInvariants: ['no_plaintext_token'],
    }).subcode).toBe('EXCEPTION_ACTIVE_LIMIT');

    expect(validateExceptionComposition({
      scopeKey: 'prod/us-west',
      activeExceptionCount: 1,
      overlays: ['no_plaintext_token'],
      requestedRelaxations: ['no_plaintext_token'],
      protectedInvariants: ['no_plaintext_token'],
    }).subcode).toBe('EXCEPTION_CONFLICTS_INVARIANT');

    expect(validateExceptionComposition({
      scopeKey: 'prod/us-west',
      activeExceptionCount: 1,
      overlays: ['allow_background_refresh', 'allow_cached_profile'],
      requestedRelaxations: ['allow_background_refresh'],
      protectedInvariants: ['no_plaintext_token'],
    })).toEqual({
      accepted: true,
      effectiveRelaxations: ['allow_background_refresh'],
      subcode: null,
    });
  });

  it('enforces forensics signer trust-chain rotation/revocation/expiry rules', () => {
    const now = Date.now();
    expect(validateForensicsSigner({
      signerId: 'sig-old',
      trustedSignerIds: ['sig-current'],
      overlapSignerIds: ['sig-old'],
      revokedSignerIds: [],
      nowMs: now,
      signatureIssuedAtMs: now - SIGNER_ROTATION_OVERLAP_MS + 1000,
      signerExpiresAtMs: now + 60_000,
    })).toEqual({ accepted: true, subcode: null });

    expect(validateForensicsSigner({
      signerId: 'sig-old',
      trustedSignerIds: ['sig-current'],
      overlapSignerIds: ['sig-old'],
      revokedSignerIds: ['sig-old'],
      nowMs: now,
      signatureIssuedAtMs: now,
      signerExpiresAtMs: now + 60_000,
    }).subcode).toBe('FORENSICS_SIGNER_REVOKED');

    expect(validateForensicsSigner({
      signerId: 'sig-old',
      trustedSignerIds: ['sig-current'],
      overlapSignerIds: ['sig-old'],
      revokedSignerIds: [],
      nowMs: now,
      signatureIssuedAtMs: now - SIGNER_ROTATION_OVERLAP_MS - 1,
      signerExpiresAtMs: now + 60_000,
    }).subcode).toBe('FORENSICS_SIGNER_UNTRUSTED');
  });

  it('applies error-budget hysteresis+dwell and waiver schema enforcement', () => {
    const now = Date.now();
    expect(resolveErrorBudgetGovernance({
      currentMode: 'enforce',
      budgetBurnPercent: 5,
      modeSinceMs: now - 1000,
      nowMs: now,
      severeIncidentOpen: false,
    })).toEqual({ nextMode: 'degraded', subcode: 'BUDGET_ENTER_DEGRADED' });

    expect(resolveErrorBudgetGovernance({
      currentMode: 'degraded',
      budgetBurnPercent: 1,
      modeSinceMs: now - ERROR_BUDGET_HOLD_DWELL_MS + 1000,
      nowMs: now,
      severeIncidentOpen: false,
    }).subcode).toBe('BUDGET_HOLD_DWELL');

    expect(resolveErrorBudgetGovernance({
      currentMode: 'degraded',
      budgetBurnPercent: 1,
      modeSinceMs: now - ERROR_BUDGET_HOLD_DWELL_MS - 1000,
      nowMs: now,
      severeIncidentOpen: true,
    }).subcode).toBe('BUDGET_HOLD_SEVERE_INCIDENT');

    expect(validateWaiverArtifact({
      schemaVersion: WAIVER_SCHEMA_VERSION,
      scope: 'prod/us-west',
      approvalCount: 2,
      minApprovals: 2,
      expiresAtMs: now + 10_000,
      nowMs: now,
      signature: 'sig',
    })).toEqual({ accepted: true, subcode: null });

    expect(validateWaiverArtifact({
      schemaVersion: 'v2',
      scope: 'prod/us-west',
      approvalCount: 2,
      minApprovals: 2,
      expiresAtMs: now + 10_000,
      nowMs: now,
      signature: 'sig',
    }).subcode).toBe('WAIVER_SCHEMA_UNSUPPORTED');
  });

  it('enforces delegation canonicalization, skew expiry, and revocation precedence', () => {
    const canonical = canonicalizeDelegationBinding({
      delegationId: 'd-1',
      principalCanonicalId: '  User:EXAMPLE-USER  ',
      runtimeMode: 'local',
      operationClass: ' rotate_token ',
      subjectDigest: 'abc',
      constraintsDigest: 'def',
      policyHash: 'ghi',
      approvalId: 'ap-1',
      nonce: 'n-1',
      expiresAt: '2026-02-17T16:00:00.000Z',
    });
    expect(canonical.principalCanonicalId).toBe('user:example-user');
    expect(canonical.operationClass).toBe('rotate_token');

    const expMs = new Date(canonical.expiresAt).getTime();
    expect(isDelegationExpired(canonical.expiresAt, expMs + DELEGATION_MAX_SKEW_MS)).toBe(false);
    expect(isDelegationExpired(canonical.expiresAt, expMs + DELEGATION_MAX_SKEW_MS + 1)).toBe(true);

    expect(resolveDelegationRevocationPrecedence({ revocationEventIndex: 10, executionCommitIndex: 10 })).toEqual({
      allowed: false,
      subcode: 'AUTH_DELEGATION_REVOKED',
    });
  });

  it('quarantines partition journal gaps/forks and accepts valid chains', () => {
    expect(validatePartitionJournalChain([
      { epoch: 1, seq: 1, entryHash: 'h1', prevEntryHash: 'root' },
      { epoch: 1, seq: 2, entryHash: 'h2', prevEntryHash: 'h1' },
    ])).toEqual({ accepted: true, subcode: 'JOURNAL_OK' });

    expect(validatePartitionJournalChain([
      { epoch: 1, seq: 1, entryHash: 'h1', prevEntryHash: 'root' },
      { epoch: 1, seq: 3, entryHash: 'h3', prevEntryHash: 'h2' },
    ]).subcode).toBe('QUARANTINED_GAP');

    expect(validatePartitionJournalChain([
      { epoch: 1, seq: 1, entryHash: 'h1', prevEntryHash: 'root' },
      { epoch: 1, seq: 1, entryHash: 'h1b', prevEntryHash: 'root' },
    ]).subcode).toBe('QUARANTINED_FORK');
  });

  it('enforces approval dedup/SoD/freshness invalidation semantics', () => {
    const now = Date.now();
    const valid = evaluateApprovalSet({
      threshold: 2,
      minDistinctTeams: 2,
      minDistinctDomains: 2,
      approvalMaxAgeMs: 15 * 60_000,
      nowMs: now,
      approvals: [
        { actorCanonicalKey: 'a', team: 'infra', domain: 'corp', approvedAtMs: now - 1_000 },
        { actorCanonicalKey: 'b', team: 'security', domain: 'vendor', approvedAtMs: now - 2_000 },
        { actorCanonicalKey: 'b', team: 'security', domain: 'vendor', approvedAtMs: now - 500 },
      ],
    });
    expect(valid.accepted).toBe(true);
    expect(valid.uniqueActors).toBe(2);

    const invalidated = evaluateApprovalSet({
      threshold: 1,
      minDistinctTeams: 1,
      minDistinctDomains: 1,
      approvalMaxAgeMs: 15 * 60_000,
      nowMs: now,
      approvals: [{ actorCanonicalKey: 'c', team: 'security', domain: 'corp', approvedAtMs: now - 1_000, revoked: true }],
    });
    expect(invalidated.subcode).toBe('AUTH_APPROVAL_SET_INVALIDATED');
  });

  it('enforces crypto phase matrix, rollback gates, compliance closure, and conflict precedence', () => {
    expect(validateCryptoPhaseState('DUAL_VERIFY', CRYPTO_PHASE_MATRIX.DUAL_VERIFY)).toEqual({
      accepted: true,
      subcode: null,
    });

    expect(validateCryptoPhaseState('RETIRE_OLD', { S_old: 1, S_new: 1, V_old: 1, V_new: 1 }).subcode).toBe(
      'AUTH_CRYPTO_PHASE_INVALID',
    );

    expect(validateCryptoRollback({ from: 'NEW_PRIMARY', to: 'DUAL_SIGN_VERIFY', targetPreconditionsMet: true })).toEqual({
      allowed: true,
      subcode: null,
    });

    expect(validateCryptoRollback({ from: 'RETIRE_OLD', to: 'DUAL_VERIFY', targetPreconditionsMet: true }).subcode).toBe(
      'AUTH_CRYPTO_ROLLBACK_NOT_PERMITTED',
    );

    expect(evaluateComplianceClosure({
      mode: 'enforce',
      manifestSchemaVersion: 'v2',
      closureStatus: 'CLOSED_COMPLETE',
      waiverLinked: false,
    }).subcode).toBe('AUTH_COMPLIANCE_SCHEMA_UNSUPPORTED');

    expect(evaluateComplianceClosure({
      mode: 'warn',
      manifestSchemaVersion: 'v1',
      closureStatus: 'CLOSED_INCOMPLETE',
      waiverLinked: false,
    }).subcode).toBe('AUTH_COMPLIANCE_WAIVER_REQUIRED');

    const precedence = resolveCausalConflictPrecedence({
      revocation: false,
      policyHashMismatch: true,
      approvalInvalid: true,
      delegationInvalid: true,
      reconciliationSuperseded: true,
      authoritativeEventRef: 'authEventIndex:1234',
    });
    expect(precedence.allowed).toBe(false);
    expect(precedence.precedenceRuleId).toBe(2);
    expect(precedence.requiredOperatorAction).toBe('re-run_with_current_policy');
  });
});
