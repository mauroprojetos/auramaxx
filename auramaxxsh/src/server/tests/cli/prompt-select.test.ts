import { beforeEach, describe, expect, it, vi } from 'vitest';

const readlineMock = vi.hoisted(() => {
  const state = { answer: '' };
  const question = vi.fn((_: string, cb: (answer: string) => void) => cb(state.answer));
  const close = vi.fn();
  const createInterface = vi.fn(() => ({ question, close }));
  return { state, question, close, createInterface };
});

vi.mock('readline', () => ({
  createInterface: readlineMock.createInterface,
}));

import { promptSelect } from '../../cli/lib/prompt';

function overrideProperty(target: object, key: string, value: unknown): () => void {
  const hadOwn = Object.prototype.hasOwnProperty.call(target, key);
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (hadOwn && original) {
      Object.defineProperty(target, key, original);
      return;
    }
    delete (target as Record<string, unknown>)[key];
  };
}

describe('promptSelect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readlineMock.state.answer = '';
  });

  it('uses arrow-key interactive selection in TTY mode', async () => {
    const setRawModeMock = vi.fn();
    const restoreStdinTTY = overrideProperty(process.stdin, 'isTTY', true);
    const restoreStdoutTTY = overrideProperty(process.stdout, 'isTTY', true);
    const restoreSetRawMode = overrideProperty(process.stdin, 'setRawMode', setRawModeMock);
    const restoreIsRaw = overrideProperty(process.stdin, 'isRaw', false);
    const restoreResume = overrideProperty(process.stdin, 'resume', vi.fn());
    const restorePause = overrideProperty(process.stdin, 'pause', vi.fn());
    const restoreIsPaused = overrideProperty(process.stdin, 'isPaused', vi.fn(() => false));
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      const selection = promptSelect(
        'How would you like to set up your agent?',
        [
          { value: 'dashboard', label: 'dashboard', aliases: ['1'] },
          { value: 'terminal', label: 'terminal', aliases: ['2'] },
        ],
        'dashboard',
      );

      process.stdin.emit('data', '\u001b[B');
      process.stdin.emit('data', '\r');

      await expect(selection).resolves.toBe('terminal');
      expect(setRawModeMock).toHaveBeenCalledWith(true);
      expect(setRawModeMock).toHaveBeenCalledWith(false);
      expect(readlineMock.createInterface).not.toHaveBeenCalled();

      const output = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(output).toContain('Use up/down arrows and Enter to confirm.');
    } finally {
      writeSpy.mockRestore();
      restoreIsPaused();
      restorePause();
      restoreResume();
      restoreIsRaw();
      restoreSetRawMode();
      restoreStdoutTTY();
      restoreStdinTTY();
    }
  });

  it('falls back to text parsing in non-TTY mode', async () => {
    const restoreStdinTTY = overrideProperty(process.stdin, 'isTTY', false);
    const restoreStdoutTTY = overrideProperty(process.stdout, 'isTTY', false);
    readlineMock.state.answer = '2';

    try {
      await expect(
        promptSelect(
          'How would you like to set up your agent?',
          [
            { value: 'dashboard', label: 'dashboard', aliases: ['1'] },
            { value: 'terminal', label: 'terminal', aliases: ['2'] },
          ],
          'dashboard',
        ),
      ).resolves.toBe('terminal');

      expect(readlineMock.createInterface).toHaveBeenCalledTimes(1);
      expect(readlineMock.question).toHaveBeenCalledTimes(1);
    } finally {
      restoreStdoutTTY();
      restoreStdinTTY();
    }
  });

  it('returns default value in non-TTY mode when input is empty', async () => {
    const restoreStdinTTY = overrideProperty(process.stdin, 'isTTY', false);
    const restoreStdoutTTY = overrideProperty(process.stdout, 'isTTY', false);
    readlineMock.state.answer = '';

    try {
      await expect(
        promptSelect(
          'How would you like to set up your agent?',
          [
            { value: 'dashboard', label: 'dashboard', aliases: ['1'] },
            { value: 'terminal', label: 'terminal', aliases: ['2'] },
          ],
          'dashboard',
        ),
      ).resolves.toBe('dashboard');
    } finally {
      restoreStdoutTTY();
      restoreStdinTTY();
    }
  });
});
