// Version constants.
//
// Single source of truth for the published version is this package's own
// package.json (`SERVER_VERSION` reads it at runtime), so `npm version` and the
// npm tarball can never disagree. `API_LEVEL` is mirrored into the WeAppDev app
// build; keep the two in sync when adding a capability.
//
// `apiLevel` is a monotonic integer (it never decreases). To decide whether a
// device supports a capability, compare the capability's apiLevel with the level
// the device reports. Never compare semver strings — "1.10" < "1.9" is a trap.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

/** Human-readable version. Informational only — never used for compatibility. */
export const SERVER_VERSION = pkg.version;

/** Monotonic capability generation. Compared as an integer. */
export const API_LEVEL = 100;

/** Supported MCP spec revisions, most preferred first. */
export const PROTOCOLS = ['2025-06-18', '2024-11-05'];
