#!/usr/bin/env node
// Cross-check server.json against package.json.
//
// The MCP Registry validates that a published package proves ownership of the
// server name: `package.json.mcpName` must equal `server.json.name`, and the
// versions must agree. Getting this wrong only fails at publish time, so we fail
// fast in CI instead.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const pkg = read('package.json');
const srv = read('server.json');

const problems = [];
const ok = (cond, msg) => { if (!cond) problems.push(msg); };

ok(typeof pkg.mcpName === 'string' && pkg.mcpName.length > 0,
  'package.json is missing `mcpName` (required for MCP Registry ownership proof)');
ok(/^io\.github\.[^/]+\//.test(pkg.mcpName || ''),
  `mcpName must start with io.github.<owner>/ — got ${pkg.mcpName}`);
ok(srv.name === pkg.mcpName,
  `server.json.name (${srv.name}) must equal package.json.mcpName (${pkg.mcpName})`);
ok(srv.version === pkg.version,
  `server.json.version (${srv.version}) must equal package.json.version (${pkg.version})`);
ok(Array.isArray(srv.packages) && srv.packages.length > 0,
  'server.json must declare at least one package (or use `remotes`)');

for (const p of srv.packages || []) {
  ok(p.registryType === 'npm',
    `unsupported registryType in server.json: ${p.registryType}`);
  ok(p.identifier === pkg.name,
    `server.json package identifier (${p.identifier}) must equal package.json name (${pkg.name})`);
  ok(p.version === pkg.version,
    `server.json package version (${p.version}) must equal package.json.version (${pkg.version})`);
  ok(p.transport && p.transport.type === 'stdio',
    'the npm package must use the stdio transport');
  ok(p.runtimeHint === 'npx',
    'runtimeHint should be npx so clients can run it without a global install');
}

// The registry caps `description` at 100 characters.
ok(srv.description.length <= 100,
  `server.json description is ${srv.description.length} chars; the registry limit is 100`);

// bin target must exist and be executable by Node.
ok(pkg.bin && typeof pkg.bin === 'object', 'package.json must declare a `bin` entry');
for (const [, rel] of Object.entries(pkg.bin || {})) {
  try {
    readFileSync(join(ROOT, rel));
  } catch {
    problems.push(`bin target does not exist: ${rel}`);
  }
}

if (problems.length) {
  console.error('server.json / package.json validation failed:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`server.json OK (name=${srv.name} version=${srv.version} npm=${pkg.name})`);
