import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { evaluateProjectScopeAccess, emitProjectScopeEvent, shouldEmitProjectScopeEvent } from '../../lib/project-scope';

function makeTmpProject(auraContent?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-scope-'));
  if (auraContent !== undefined) {
    fs.writeFileSync(path.join(dir, '.aura'), auraContent, 'utf-8');
  }
  return dir;
}

function makeTmpProjectWithAuraDirectory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-scope-'));
  fs.mkdirSync(path.join(dir, '.aura'));
  return dir;
}

describe('project scope', () => {
  it('allows when .aura is missing in auto mode', () => {
    const dir = makeTmpProject();
    const decision = evaluateProjectScopeAccess({
      surface: 'cli_agent_get',
      requested: { agentName: null, credentialName: 'github' },
      candidates: [{ id: '1', name: 'github', agentName: 'agent' }],
      cwd: dir,
      projectRootOverride: dir,
      projectScopeMode: 'auto',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBeNull();
  });

  it('allows when .aura is a directory in auto mode', () => {
    const dir = makeTmpProjectWithAuraDirectory();
    const decision = evaluateProjectScopeAccess({
      surface: 'cli_agent_get',
      requested: { agentName: null, credentialName: 'github' },
      candidates: [{ id: '1', name: 'github', agentName: 'agent' }],
      cwd: dir,
      projectRootOverride: dir,
      projectScopeMode: 'auto',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBeNull();
  });

  it('denies when .aura is a directory in strict mode', () => {
    const dir = makeTmpProjectWithAuraDirectory();
    const decision = evaluateProjectScopeAccess({
      surface: 'cli_agent_get',
      requested: { agentName: null, credentialName: 'github' },
      candidates: [{ id: '1', name: 'github', agentName: 'agent' }],
      cwd: dir,
      projectRootOverride: dir,
      projectScopeMode: 'strict',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('PROJECT_SCOPE_INVALID_AURA');
    expect(decision.remediation).toContain('.aura must be a file');
  });

  it('defaults to off when no projectScopeMode is configured', () => {
    const dir = makeTmpProject();
    const oldMode = process.env.AURA_PROJECT_SCOPE_MODE;
    delete process.env.AURA_PROJECT_SCOPE_MODE;

    const decision = evaluateProjectScopeAccess({
      surface: 'cli_agent_get',
      requested: { agentName: null, credentialName: 'github' },
      candidates: [{ id: '1', name: 'github', agentName: 'agent' }],
      cwd: dir,
      projectRootOverride: dir,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.projectScopeMode).toBe('off');

    if (oldMode === undefined) {
      delete process.env.AURA_PROJECT_SCOPE_MODE;
    } else {
      process.env.AURA_PROJECT_SCOPE_MODE = oldMode;
    }
  });

  it('honors explicit strict env override', () => {
    const dir = makeTmpProject();
    const oldMode = process.env.AURA_PROJECT_SCOPE_MODE;
    process.env.AURA_PROJECT_SCOPE_MODE = 'strict';

    const decision = evaluateProjectScopeAccess({
      surface: 'cli_agent_get',
      requested: { agentName: null, credentialName: 'github' },
      candidates: [{ id: '1', name: 'github', agentName: 'agent' }],
      cwd: dir,
      projectRootOverride: dir,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('PROJECT_SCOPE_MISSING_AURA');

    if (oldMode === undefined) {
      delete process.env.AURA_PROJECT_SCOPE_MODE;
    } else {
      process.env.AURA_PROJECT_SCOPE_MODE = oldMode;
    }
  });

  it('denies when .aura is missing in strict mode', () => {
    const dir = makeTmpProject();
    const decision = evaluateProjectScopeAccess({
      surface: 'cli_agent_get',
      requested: { agentName: null, credentialName: 'github' },
      candidates: [{ id: '1', name: 'github', agentName: 'agent' }],
      cwd: dir,
      projectRootOverride: dir,
      projectScopeMode: 'strict',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('PROJECT_SCOPE_MISSING_AURA');
  });

  it('allows mapped credential in named agent', () => {
    const dir = makeTmpProject('GITHUB=@agent/github/token\n');
    const decision = evaluateProjectScopeAccess({
      surface: 'cli_agent_get',
      requested: { agentName: 'agent', credentialName: 'github' },
      candidates: [{ id: '1', name: 'github', agentName: 'agent' }],
      cwd: dir,
      projectRootOverride: dir,
      projectScopeMode: 'auto',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.allowedCandidates).toHaveLength(1);
  });

  it('allows when .aura syntax is invalid in auto mode', () => {
    const dir = makeTmpProject('THIS_IS_NOT_VALID');
    const decision = evaluateProjectScopeAccess({
      surface: 'cli_agent_get',
      requested: { agentName: null, credentialName: 'github' },
      candidates: [{ id: '1', name: 'github', agentName: 'agent' }],
      cwd: dir,
      projectRootOverride: dir,
      projectScopeMode: 'auto',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBeNull();
  });

  it('denies unmapped credential', () => {
    const dir = makeTmpProject('OPENAI=@agent/openai/api_key\n');
    const decision = evaluateProjectScopeAccess({
      surface: 'mcp_get_secret',
      requested: { agentName: null, credentialName: 'github' },
      candidates: [{ id: '1', name: 'github', agentName: 'agent' }],
      cwd: dir,
      projectRootOverride: dir,
      projectScopeMode: 'auto',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('PROJECT_SCOPE_DENIED');
  });

  it('denies ambiguous matches when agent omitted', () => {
    const dir = makeTmpProject('DB=@prod/db/password\nDB2=@staging/db/password\n');
    const decision = evaluateProjectScopeAccess({
      surface: 'cli_agent_get',
      requested: { agentName: null, credentialName: 'db' },
      candidates: [
        { id: '1', name: 'db', agentName: 'prod' },
        { id: '2', name: 'db', agentName: 'staging' },
      ],
      cwd: dir,
      projectRootOverride: dir,
      projectScopeMode: 'auto',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('PROJECT_SCOPE_DENIED');
  });
});

describe('project scope diagnostics', () => {
  const baseDecision = {
    allowed: true,
    code: null,
    remediation: '',
    projectScopeMode: 'auto' as const,
    normalizedIdentity: { agentName: null, credentialName: 'OURSECRET' },
    projectRoot: '/tmp/project',
    auraFingerprint: 'abc123',
    allowedCandidates: [{ id: '1', name: 'OURSECRET', agentName: 'primary' }],
  };

  afterEach(() => {
    delete process.env.AURA_PROJECT_SCOPE_DEBUG;
  });

  it('is disabled by default', () => {
    expect(shouldEmitProjectScopeEvent({})).toBe(false);
  });

  it('accepts common truthy debug values', () => {
    expect(shouldEmitProjectScopeEvent({ AURA_PROJECT_SCOPE_DEBUG: '1' })).toBe(true);
    expect(shouldEmitProjectScopeEvent({ AURA_PROJECT_SCOPE_DEBUG: 'true' })).toBe(true);
    expect(shouldEmitProjectScopeEvent({ AURA_PROJECT_SCOPE_DEBUG: 'yes' })).toBe(true);
    expect(shouldEmitProjectScopeEvent({ AURA_PROJECT_SCOPE_DEBUG: 'on' })).toBe(true);
  });

  it('does not emit logs unless debug is enabled', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    emitProjectScopeEvent({
      actor: 'cli-agent',
      surface: 'cli_agent_get',
      requestedCredential: { agentName: null, credentialName: 'OURSECRET' },
      decision: baseDecision,
    });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('emits logs when debug is enabled', () => {
    process.env.AURA_PROJECT_SCOPE_DEBUG = '1';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    emitProjectScopeEvent({
      actor: 'cli-agent',
      surface: 'cli_agent_get',
      requestedCredential: { agentName: null, credentialName: 'OURSECRET' },
      decision: baseDecision,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0];
    expect(String(message)).toContain('[project-scope]');
    warnSpy.mockRestore();
  });
});
