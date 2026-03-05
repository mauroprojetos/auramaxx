import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('e2e-agent CI lane contracts', () => {
  it('keeps PR smoke lane fixed to the 3 required scenarios', () => {
    const smokePath = path.resolve(__dirname, 'ci/pr-smoke-set.json');
    const smokeSet = JSON.parse(fs.readFileSync(smokePath, 'utf8')) as string[];

    expect(smokeSet).toEqual([
      'credential-create-basic',
      'credential-read-basic',
      'aura-onboarding-sanity',
    ]);
  });
});
