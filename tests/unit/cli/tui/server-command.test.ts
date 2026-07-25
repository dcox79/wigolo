import { describe, expect, it } from 'vitest';
import { getPinnedServerCommand } from '../../../../src/cli/tui/server-command.js';

describe('getPinnedServerCommand', () => {
  it('pins generated npx configuration to the running package version', () => {
    expect(getPinnedServerCommand()).toEqual({
      command: 'npx',
      args: ['-y', 'wigolo@0.2.1'],
    });
  });
});
