import { join } from 'node:path';
import { homedir } from 'node:os';
import { runCommand } from './run-command.js';
import { mergeMcpJson } from '../agents/utils.js';
import { getPinnedServerCommand } from './server-command.js';

export interface InstallViaClaudeCliArgs {
  dryRun?: boolean;
}

export interface InstallViaClaudeCliResult {
  ok: boolean;
  code?: 'OK' | 'OK_FALLBACK' | 'CLAUDE_NOT_FOUND' | 'CLAUDE_FAILED';
  message?: string;
  alreadyInstalled?: boolean;
  dryRun?: boolean;
  usedFallback?: boolean;
  fallbackPath?: string;
}

function writeClaudeJsonFallback(): InstallViaClaudeCliResult {
  const server = getPinnedServerCommand();
  const fallbackPath = join(homedir(), '.claude.json');
  mergeMcpJson(
    fallbackPath,
    { command: server.command, args: server.args },
    ['mcpServers', 'wigolo'],
  );
  return {
    ok: true,
    code: 'OK_FALLBACK',
    usedFallback: true,
    fallbackPath,
    message: `Claude Code CLI not found; wrote MCP entry directly to ${fallbackPath}`,
  };
}

export async function installViaClaudeCli(args: InstallViaClaudeCliArgs = {}): Promise<InstallViaClaudeCliResult> {
  if (args.dryRun) {
    return { ok: true, code: 'OK', dryRun: true };
  }

  let r;
  try {
    const server = getPinnedServerCommand();
    r = await runCommand(
      'claude',
      ['mcp', 'add', 'wigolo', '--scope', 'user', '--', server.command, ...server.args],
      { timeout: 15000 },
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT' || /ENOENT|spawn .* ENOENT/.test(e.message)) {
      return writeClaudeJsonFallback();
    }
    return { ok: false, code: 'CLAUDE_FAILED', message: e.message };
  }

  if (r.code === 0) {
    return { ok: true, code: 'OK', alreadyInstalled: false };
  }
  if (/already exists/i.test(r.stderr) || /already exists/i.test(r.stdout)) {
    return { ok: true, code: 'OK', alreadyInstalled: true };
  }
  return {
    ok: false,
    code: 'CLAUDE_FAILED',
    message: (r.stderr || r.stdout || `exit ${r.code}`).trim(),
  };
}
