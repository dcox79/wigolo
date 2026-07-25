#!/usr/bin/env node
// Thin launcher for the MCPB bundle: runs the published wigolo MCP server via
// npx so the bundle stays lightweight. The exact version is pinned so a later
// npm `latest` publication cannot replace the code this bundle was reviewed for.
// CommonJS (.cjs) so it runs correctly inside the bundle, which ships no package.json.
const { spawn } = require('node:child_process');

const child = spawn('npx', ['-y', 'wigolo@0.2.1', 'mcp'], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error(err);
  process.exit(1);
});
