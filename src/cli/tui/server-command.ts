import { getPackageVersion } from './version.js';

/**
 * Return an immutable npm launch specification for generated MCP configs.
 *
 * A bare `npx wigolo` silently tracks the mutable `latest` tag, so a client
 * restart could execute code that was never reviewed. Pinning to the running
 * package version keeps generated configurations on the exact release the user
 * chose. Local fork/container deployments should still point clients directly
 * at their local build or HTTP endpoint.
 */
export function getPinnedServerCommand(): { command: 'npx'; args: string[] } {
  const version = getPackageVersion();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Cannot generate a pinned MCP command: invalid package version '${version}'`);
  }
  return { command: 'npx', args: ['-y', `wigolo@${version}`] };
}
