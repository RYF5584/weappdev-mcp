// Capability negotiation: the cross-device (union) tool table, per-device support
// checks, and explicit unsupported-tool errors.
//
// The problem this solves:
//  - This server may be NEWER than a phone (phone lacks a tool). The caller must
//    be told "this device does not support that tool" instead of receiving an
//    opaque E_UNKNOWN_TOOL from the phone.
//  - This server may be OLDER than a phone (phone has extra tools). Those must
//    still be callable, via the phone's `wad_tools` meta tool.
//  - Devices may have different tool sets, so the advertised table is the UNION
//    with per-device annotations.
//
// Only two inputs are trusted:
//  1) `/json/version.mcpTools` — the exact tool-name list reported by the device
//  2) `/json/version.mcpApiLevel` — an integer, used to explain *why* a tool is missing
// Semver strings are never compared.

import { API_LEVEL as AGG_API_LEVEL, SERVER_VERSION as AGG_VERSION } from './version.mjs';

/** Canonical name of the forward-compatibility meta tool. */
export const META_TOOL = 'wad_tools';

/**
 * Minimum apiLevel that provides the `wad_tools` meta tool.
 *
 * The phone registry declares wad_tools with since=2 (it shipped in the apiLevel 2
 * generation). Current device generation: app 1.1.0 / apiLevel 100
 * (config/mcp-version.json). If the meta tool ever moves again, bump this constant.
 */
export const META_TOOL_API_LEVEL = 2;

/** Compatibility verdicts. */
export const COMPAT = {
  OK: 'ok',                     // device supports the tool directly
  VIA_META: 'via_meta',         // tool name unknown, but the meta channel exists
  UNSUPPORTED: 'unsupported',   // device definitely lacks it
  UNKNOWN: 'unknown',           // device did not report a tool list (older app)
};

/**
 * Decide whether a device supports a tool.
 *
 * Precedence (each line below maps to a real failure seen in the field):
 *  1. Device reported an exact tool list → that list is authoritative.
 *     Present = OK, absent = UNSUPPORTED (retrying through the meta tool would
 *     only add a round trip and reach the same conclusion).
 *  2. No list, but the device is new enough for the meta channel → VIA_META.
 *  3. Neither → UNKNOWN: forward optimistically and upgrade the phone's
 *     "unknown tool" into an explicit error.
 *
 * @param {any} rec device record (toolNames / mcpApiLevel)
 * @param {string} name tool name
 * @param {number} [since] apiLevel that introduced the tool (from the catalog)
 * @returns {'ok'|'via_meta'|'unsupported'|'unknown'}
 */
export function deviceSupport(rec, name, since) {
  if (!rec) return COMPAT.UNKNOWN;
  const names = Array.isArray(rec.toolNames) ? rec.toolNames : [];
  if (names.length > 0) {
    return names.includes(name) ? COMPAT.OK : COMPAT.UNSUPPORTED;
  }
  const lvl = Number(rec.mcpApiLevel || 0);
  if (lvl >= META_TOOL_API_LEVEL) return COMPAT.VIA_META;
  if (since && lvl > 0 && lvl < since) return COMPAT.UNSUPPORTED;
  return COMPAT.UNKNOWN;
}

/** Human-readable explanation for an error hint. */
export function supportHint(rec, name) {
  const alias = (rec && rec.alias) || 'this device';
  const lvl = Number((rec && rec.mcpApiLevel) || 0);
  const ver = (rec && rec.mcpVersion) || 'unknown';
  const hasMeta = Array.isArray(rec && rec.toolNames) && rec.toolNames.includes(META_TOOL);
  if (hasMeta) {
    return `${alias} does not support ${name} (phone MCP ${ver} / apiLevel ${lvl}). `
      + `Call ${META_TOOL} {action:'list'} to see what it does support.`;
  }
  return `${alias} does not support ${name} (phone MCP ${ver} / apiLevel ${lvl}, `
    + `no ${META_TOOL} channel). Upgrade the WeAppDev app on the phone.`;
}

/**
 * Build the cross-device tool table.
 *
 * Rules:
 *  - Base: union of every online device's tools/list (deduplicated by name,
 *    keeping the most complete schema)
 *  - Plus the built-in catalog, so tools that no connected device reports are
 *    still visible and fail with a clear error
 *  - Every tool gets `_meta.devices` (aliases that support it) and
 *    `_meta.unsupportedBy`
 *
 * @param {Array<{alias:string, tools:Array, rec?:any}>} perDevice
 * @param {Array<{name:string, since?:number, group?:string}>} catalog
 * @returns {Array<any>}
 */
export function buildUnionTools(perDevice, catalog) {
  /** @type {Map<string, any>} */
  const merged = new Map();

  const mergeOne = (tool, alias) => {
    const name = tool && tool.name;
    if (!name) return;
    const cur = merged.get(name);
    if (!cur) {
      merged.set(name, {
        ...tool,
        _meta: { ...(tool._meta || {}), devices: alias ? [alias] : [], unsupportedBy: [] },
      });
      return;
    }
    // Already present: keep the richer schema (more properties).
    const curProps = Object.keys((cur.inputSchema && cur.inputSchema.properties) || {}).length;
    const newProps = Object.keys((tool.inputSchema && tool.inputSchema.properties) || {}).length;
    if (newProps > curProps) {
      merged.set(name, {
        ...tool,
        _meta: { ...(tool._meta || {}), devices: cur._meta.devices, unsupportedBy: cur._meta.unsupportedBy },
      });
    }
    if (alias && !cur._meta.devices.includes(alias)) cur._meta.devices.push(alias);
  };

  // 1) Real devices (union).
  for (const d of perDevice || []) {
    for (const t of d.tools || []) mergeOne(t, d.alias);
  }

  // 2) Built-in catalog: adds tools no device reported (including wad_tools).
  for (const c of catalog || []) {
    if (!c || !c.name) continue;
    if (merged.has(c.name)) continue;
    merged.set(c.name, catalogToolToDescriptor(c));
  }

  // 3) Annotate per-device support.
  const allAliases = (perDevice || []).map((d) => d.alias);
  for (const [, tool] of merged) {
    const sup = tool._meta.devices || [];
    tool._meta.unsupportedBy = allAliases.filter((a) => !sup.includes(a));
    tool._meta.availableOn = sup.length ? sup : allAliases.slice();
    if (sup.length === 0) {
      tool._meta.note = 'no connected device reports this tool; calling it returns E_UNSUPPORTED_BY_DEVICE';
    }
  }

  return Array.from(merged.values()).sort((a, b) => {
    // Stable order: by group, then by name — easier for a model to scan.
    const ga = (a._meta && a._meta.group) || '';
    const gb = (b._meta && b._meta.group) || '';
    if (ga !== gb) return ga < gb ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/** Catalog entry → MCP tool descriptor (placeholder; calls are intercepted). */
function catalogToolToDescriptor(c) {
  return {
    name: c.name,
    title: c.title || c.name,
    description: (c.description
      || `${c.name}: known tool that no connected device reports. Calling it returns `
         + 'E_UNSUPPORTED_BY_DEVICE with the reason.'),
    inputSchema: c.inputSchema || { type: 'object', properties: {}, additionalProperties: true },
    annotations: {
      readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false,
    },
    _meta: {
      group: c.group || 'core',
      since: c.since || 1,
      catalogOnly: true,
      devices: [],
      unsupportedBy: [],
    },
  };
}

/** This aggregator's own identity (initialize.serverInfo / wad_devices). */
export function aggregatorInfo() {
  return {
    name: 'weappdev-mcp',
    version: AGG_VERSION,
    apiLevel: AGG_API_LEVEL,
    role: 'aggregator',
  };
}
