#!/usr/bin/env node
// WeAppDev MCP multi-device aggregator (stdio transport).
//
// Usage:
//   npx -y weappdev-mcp                          # client spawns it; exits with the session
//   node src/cli.mjs --scan                      # also scan the local /24 (9400-9411)
//   node src/cli.mjs --no-mdns                   # disable mDNS discovery
//   node src/cli.mjs --debug                     # verbose logs on stderr
//
// Design points (read the invariants at the top of device.mjs first):
//  1) **One MCP config, configured once.** The device is chosen by the model via
//     wad_devices / wad_device_use / a per-call `device`.
//  2) Five AI sessions = five processes = five independent registries, so sessions
//     cannot interfere with each other.
//  3) initialize / tools/list return immediately (discovery is fire-and-forget);
//     only tools/call waits for discovery (bounded by the discovery budget).
//  4) Steady-state call = one Map lookup + one HTTP forward. Transport is
//     re-resolved only on first use, on connection failure, or on HTTP 404.
//
// Zero dependencies: Node.js >= 22 (global fetch / AbortSignal.timeout).

import { StdioChannel, log } from './jsonrpc.mjs';
import { Registry, DeviceError } from './device.mjs';
import { FLEET_TOOLS, injectDevice } from './tools.mjs';
import {
  META_TOOL, COMPAT, deviceSupport, supportHint, buildUnionTools, aggregatorInfo,
} from './capabilities.mjs';
import { PROTOCOLS } from './version.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const ARGS = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const o = { scan: false, mdns: true, seed: true, usb: true, debug: false, help: false };
  for (const a of argv) {
    if (a === '--scan') o.scan = true;
    else if (a === '--no-mdns') o.mdns = false;
    else if (a === '--no-seed') o.seed = false;
    else if (a === '--no-usb') o.usb = false;
    else if (a === '--debug') o.debug = true;
    else if (a === '--version' || a === '-v') o.version = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('-')) {
      process.stderr.write(`unknown option: ${a}\n`);
      o.help = true;
    }
  }
  return o;
}

if (ARGS.version) {
  // Printed to stdout on purpose: this is not a protocol session.
  process.stdout.write(aggregatorInfo().version + '\n');
  process.exit(0);
}
if (ARGS.help) {
  process.stdout.write(
    'WeAppDev MCP aggregator (stdio)\n'
    + '\n'
    + '  --scan        also scan the local /24 for ports 9400-9411 (off by default)\n'
    + '  --no-mdns     disable mDNS discovery\n'
    + '  --no-seed     ignore ~/.weappdev/devices.json\n'
    + '  --no-usb      disable adb discovery\n'
    + '  --debug       verbose logs on stderr\n'
    + '  --version     print the version and exit\n'
    + '  --help        print this help and exit\n'
    + '\n'
    + 'Environment:\n'
    + '  ADB_BIN       path to adb (default: adb)\n');
  process.exit(0);
}

const channel = new StdioChannel();
const registry = new Registry(ARGS);

/** Built-in catalog: keeps new tools visible when every phone is older than us. */
function loadCatalog() {
  try {
    const j = JSON.parse(readFileSync(join(HERE, 'catalog.json'), 'utf8'));
    return Array.isArray(j.tools) ? j.tools : [];
  } catch (e) {
    log('failed to read catalog.json (falling back to device tool lists only):',
      String(e && e.message || e));
    return [];
  }
}
const CATALOG = loadCatalog();
const CATALOG_BY_NAME = new Map(CATALOG.map((t) => [t.name, t]));

const SERVER_INFO = aggregatorInfo();
/** Protocol version negotiated with the client (one stdio client per process). */
let protocolVersion = PROTOCOLS[0];
/** Union tool table cache, rebuilt when the device snapshot changes. */
let cachedTools = null;
let toolsLoading = null;
/** Signature of the device snapshot the table was built from. */
let toolsSignature = '';

// Exit-time cleanup: remove only the adb forwards this process created.
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { await registry.shutdown(); } catch {}
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => { await cleanup(); process.exit(0); });
}
process.on('beforeExit', cleanup);
process.on('uncaughtException', (e) => { log('uncaught:', e && e.stack || e); });
process.on('unhandledRejection', (e) => { log('unhandled:', e && e.stack || e); });

// ────────────────────────────────────────────── tool table

/**
 * Build the cross-device union tool table.
 *
 * See the header of capabilities.mjs before changing this:
 *  1) **Union**: when devices differ, every tool is still advertised, annotated
 *     with `_meta.devices` / `_meta.unsupportedBy`.
 *  2) **Catalog fallback**: tools that no connected phone reports still appear,
 *     and calling them returns E_UNSUPPORTED_BY_DEVICE.
 *  3) **Forward compatibility**: a phone that has `wad_tools` can execute a tool
 *     this process has never heard of (see callTool).
 *  4) The build signature is recorded so a changed device set/version rebuilds it.
 */
async function loadTools() {
  await registry.ensureDiscovered();
  const list = Array.from(registry.devices.values());
  const sig = list.map((d) => `${d.alias}:${d.mcpApiLevel}:${d.toolsCount}`).sort().join('|');
  if (cachedTools && sig === toolsSignature) return cachedTools;
  if (toolsLoading) return toolsLoading;

  toolsLoading = (async () => {
    // Fetch tools/list from every device concurrently; one failure cannot break the rest.
    const perDevice = await Promise.all(list.map(async (rec) => {
      try {
        const r = await registry.forward(rec, {
          jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
        });
        let tools = r && r.result && Array.isArray(r.result.tools) ? r.result.tools : [];
        // Older apps omit `_meta.since`; default it to 1 (or the catalog value).
        tools = tools.map((t) => {
          const c = CATALOG_BY_NAME.get(t.name);
          const since = (t._meta && t._meta.since) || (c && c.since) || 1;
          return { ...t, _meta: { ...(t._meta || {}), since } };
        });
        return { alias: rec.alias, tools, rec };
      } catch (e) {
        log(`failed to read the tool list from ${rec.alias}:`,
          String(e && e.message || e).slice(0, 90));
        return { alias: rec.alias, tools: [], rec };
      }
    }));

    const okDevices = perDevice.filter((d) => d.tools.length > 0);
    if (okDevices.length === 0) {
      // Nothing responded: expose the fleet tools only, so wad_devices still works.
      cachedTools = FLEET_TOOLS.slice();
      toolsSignature = sig;
      log('no device reported a tool list; exposing fleet tools only',
        `(catalog has ${CATALOG.length} entries)`);
      return cachedTools;
    }

    const union = buildUnionTools(okDevices, CATALOG);
    cachedTools = injectDevice(union).concat(FLEET_TOOLS);
    toolsSignature = sig;

    const names = okDevices.map((d) => `${d.alias}=${d.tools.length}`).join(' ');
    const catalogOnly = union.filter((t) => t._meta && t._meta.catalogOnly).length;
    log(`union tool table: ${union.length} + ${FLEET_TOOLS.length} (${names}`
      + `${catalogOnly ? `, catalog-only ${catalogOnly}` : ''})`);
    return cachedTools;
  })();

  try {
    return await toolsLoading;
  } finally {
    toolsLoading = null;
  }
}

// ────────────────────────────────────────────── dispatch

async function handle(msg) {
  const method = msg && msg.method;
  const id = msg && msg.id;
  const isNotification = id === undefined || id === null;

  // Notifications never get a reply.
  if (typeof method === 'string' && method.startsWith('notifications/')) return null;

  try {
    if (method === 'initialize') {
      const req = (msg.params && msg.params.protocolVersion) || PROTOCOLS[0];
      protocolVersion = PROTOCOLS.includes(req) ? req : PROTOCOLS[0];
      // Start discovery in the background; never block initialize.
      registry.ensureDiscovered().catch(() => {});
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
            prompts: {},
            completions: {},
          },
          serverInfo: {
            name: SERVER_INFO.name,
            version: SERVER_INFO.version,
            apiLevel: SERVER_INFO.apiLevel,
          },
          instructions:
            'WeAppDev MCP (multi-device aggregator). Start with: '
            + '1) wad_devices to list phones (each `device` field is an alias, and every '
            + 'entry carries mcpVersion / mcpApiLevel / toolsCount); '
            + '2) wad_device_use to pin the phone you are working on (this session only); '
            + '3) call any other tool without `device` and it goes to the pinned phone. '
            + 'Pass `device` on a single call to switch temporarily. '
            + 'With exactly one phone online you can skip step 2 — it is selected automatically. '
            + 'The advertised tool table is a **union across devices**: each tool has '
            + '_meta.devices (aliases that support it) and _meta.unsupportedBy. '
            + 'A call that returns E_UNSUPPORTED_BY_DEVICE means that phone\'s app version '
            + 'lacks the tool — follow the hint, or upgrade the app. '
            + 'When a phone is newer than this server, use wad_tools '
            + '(action=list|describe|call) to enumerate and invoke what it really supports. '
            + 'Recipes: resources wad://docs/reverse and wad://docs/ws.',
        },
      };
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'tools/list') {
      const tools = await loadTools();
      return { jsonrpc: '2.0', id, result: { tools } };
    }

    if (method === 'resources/list') {
      return {
        jsonrpc: '2.0', id,
        result: {
          resources: [
            { uri: 'wad://docs/reverse', name: 'docs/reverse', mimeType: 'text/markdown',
              description: 'Reverse-engineering recipe: capture -> initiator -> source -> text breakpoint -> paused state' },
            { uri: 'wad://docs/ws', name: 'docs/ws', mimeType: 'text/markdown',
              description: 'WebSocket lifecycle (list/frames/send/recv/block/rewrite)' },
            { uri: 'wad://docs/tools', name: 'docs/tools', mimeType: 'text/markdown',
              description: 'Tool overview and groups' },
          ],
        },
      };
    }

    if (method === 'resources/read') {
      // Resource bodies come from the phone (wad://docs/*): resolve a device, then forward.
      return await proxyRpc(msg);
    }

    if (method === 'prompts/list' || method === 'prompts/get' || method === 'completion/complete') {
      return await proxyRpc(msg);
    }

    if (method === 'tools/call') {
      return await callTool(msg);
    }

    return rpcErr(id, -32601, `unknown method: ${method}`);
  } catch (e) {
    if (isNotification) return null;
    if (e instanceof DeviceError) {
      return toolErr(msg.id, e.code, e.message, e.hint);
    }
    log('handler error:', e && e.stack || e);
    return rpcErr(id, -32603, String(e && e.message || e));
  }
}

/** Generic forward (resources / prompts / completion): needs one device. */
async function proxyRpc(msg) {
  try {
    const rec = await registry.resolve(msg.params && msg.params.device);
    return await registry.forward(rec, msg);
  } catch (e) {
    if (e instanceof DeviceError) {
      return toolErr(msg.id, e.code, e.message, e.hint);
    }
    throw e;
  }
}

/**
 * Is this tool name inside what this process knows about (union table / catalog /
 * fleet tools)?
 *
 * A name outside it means either the client uses a tool newer than this
 * aggregator (old aggregator + new phone) or a typo. The former must be forwarded
 * through `wad_tools` so the phone decides; a typo comes back as E_UNKNOWN_TOOL and
 * is translated into an explicit unsupported-tool error.
 */
async function isKnownTool(name) {
  if (name === 'wad_devices' || name === 'wad_device_use') return true;
  if (CATALOG_BY_NAME.has(name)) return true;
  const tools = await loadTools();
  return tools.some((t) => t && t.name === name);
}

async function callTool(msg) {
  const name = (msg.params && msg.params.name) || '';
  const argsIn = (msg.params && msg.params.arguments) || {};

  // ── aggregator-owned tools ──────────────────
  if (name === 'wad_devices') {
    try {
      await registry.ensureDiscovered();
      return toolOk(msg.id, registry.listPayload());
    } catch (e) {
      return toolErr(msg.id, 'E_DISCOVER', String(e && e.message || e));
    }
  }
  if (name === 'wad_device_use') {
    try {
      const out = await registry.use(argsIn.device);
      return toolOk(msg.id, out);
    } catch (e) {
      if (e instanceof DeviceError) return toolErr(msg.id, e.code, e.message, e.hint);
      return toolErr(msg.id, 'E_BAD_ARGS', String(e && e.message || e));
    }
  }

  // ── everything else: strip `device`, then forward ──
  const device = typeof argsIn.device === 'string' ? argsIn.device : undefined;
  const args = { ...argsIn };
  delete args.device;

  let rec;
  try {
    rec = await registry.resolve(device);
  } catch (e) {
    if (e instanceof DeviceError) return toolErr(msg.id, e.code, e.message, e.hint);
    return toolErr(msg.id, 'E_ROUTE', String(e && e.message || e));
  }

  // ── capability pre-check: say "this phone does not support it" explicitly ──
  const cat = CATALOG_BY_NAME.get(name);
  const support = deviceSupport(rec, name, cat && cat.since);
  if (support === COMPAT.UNSUPPORTED) {
    return toolErr(msg.id, 'E_UNSUPPORTED_BY_DEVICE',
      `${rec.alias} does not support ${name} (phone MCP ${rec.mcpVersion || 'unknown'} / `
      + `apiLevel ${rec.mcpApiLevel || 0})`,
      supportHint(rec, name));
  }
  if (support === COMPAT.VIA_META) {
    // No exact tool list, but the device is new enough for the meta channel. This is
    // the "old aggregator + new phone" path: the model names a tool we do not know.
    log(`calling ${name} through ${META_TOOL} -> ${rec.alias}`);
    return await callViaMeta(msg.id, rec, name, args);
  }
  // Completely unknown tool name (newer than this process's catalog): let the phone decide.
  if (!CATALOG_BY_NAME.has(name) && !(await isKnownTool(name))) {
    log(`unknown tool name ${name}; forwarding through ${META_TOOL} -> ${rec.alias}`);
    return await callViaMeta(msg.id, rec, name, args);
  }

  // wad_batch re-dispatches its ops on the phone, which cannot see the outer
  // `device`, so stamp each op (without overwriting one that is already set).
  if (name === 'wad_batch' && Array.isArray(args.ops)) {
    args.ops = args.ops.map((op) => {
      if (!op || typeof op !== 'object') return op;
      const a = op.args && typeof op.args === 'object' ? op.args : {};
      if (Object.prototype.hasOwnProperty.call(a, 'device')) return op;
      return { ...op, args: { ...a, device: rec.alias } };
    });
  }

  try {
    const r = await registry.forward(rec, {
      jsonrpc: '2.0', id: msg.id, method: 'tools/call',
      params: { name, arguments: args },
    });
    // Pass the phone's result through untouched (content/isError/structuredContent),
    // except "unknown tool", which becomes an explicit version error.
    if (isUnknownToolResult(r)) {
      return toolErr(msg.id, 'E_UNSUPPORTED_BY_DEVICE',
        `${rec.alias} does not support ${name} (phone MCP ${rec.mcpVersion || 'unknown'} / `
        + `apiLevel ${rec.mcpApiLevel || 0})`,
        supportHint(rec, name));
    }
    return r;
  } catch (e) {
    if (e instanceof DeviceError) return toolErr(msg.id, e.code, e.message, e.hint);
    return toolErr(msg.id, 'E_FORWARD', String(e && e.message || e));
  }
}

/** Two shapes of "unknown tool" from a phone: JSON-RPC -32602, or E_UNKNOWN_TOOL. */
function isUnknownToolResult(r) {
  if (!r) return false;
  if (r.error && r.error.code === -32602) return true;
  const sc = r.result && r.result.structuredContent;
  if (sc && (sc.error === 'E_UNKNOWN_TOOL' || /unknown tool/i.test(String(sc.message || '')))) {
    return true;
  }
  return false;
}

/**
 * Call through the phone's `wad_tools` meta tool (forward-compatibility channel).
 *
 * Used when the phone is newer than this server: neither the catalog nor the
 * schema here knows the tool. If the phone does not have the meta tool either, the
 * call is reported as an explicit unsupported-tool error.
 */
async function callViaMeta(id, rec, name, args) {
  try {
    const r = await registry.forward(rec, {
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: META_TOOL, arguments: { action: 'call', name, args } },
    });
    const inner = unwrapMetaResult(r);
    if (inner === META_MISSING) {
      return toolErr(id, 'E_UNSUPPORTED_BY_DEVICE',
        `${rec.alias} does not support ${name} (phone MCP ${rec.mcpVersion || 'unknown'} / `
        + `apiLevel ${rec.mcpApiLevel || 0}, no ${META_TOOL} channel)`,
        'Upgrade the app on the phone, or use a tool that version supports '
        + '(wad_capabilities / wad_help).');
    }
    return inner;
  } catch (e) {
    if (e instanceof DeviceError) return toolErr(id, e.code, e.message, e.hint);
    return toolErr(id, 'E_FORWARD', String(e && e.message || e));
  }
}

/** Marker for "the phone does not have wad_tools at all". */
const META_MISSING = Symbol('meta-missing');

/**
 * Unwrap `wad_tools {action:'call'}` so the result looks like a direct call. The
 * only special case is "the channel does not exist".
 */
function unwrapMetaResult(r) {
  if (!r) return r;
  if (r.error && r.error.code === -32602) return META_MISSING;   // phone has no wad_tools
  const sc = r.result && r.result.structuredContent;
  if (sc && sc.error === 'E_UNKNOWN_TOOL' && /wad_tools/.test(String(sc.message || ''))) {
    return META_MISSING;
  }
  return r;
}

// ────────────────────────────────────────────── response helpers

function toolOk(id, obj) {
  return {
    jsonrpc: '2.0', id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(obj) }],
      structuredContent: obj,
      isError: false,
    },
  };
}

function toolErr(id, code, message, hint) {
  const o = { ok: false, error: code, message: message || '', retryable: false };
  if (hint) o.hint = hint;
  return {
    jsonrpc: '2.0', id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(o) }],
      structuredContent: o,
      isError: true,
    },
  };
}

function rpcErr(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

// ────────────────────────────────────────────── main loop

async function main() {
  log(`starting (scan=${ARGS.scan} mdns=${ARGS.mdns} seed=${ARGS.seed} usb=${ARGS.usb})`);
  // Warm up discovery and the tool table in the background; do not block initialize.
  registry.ensureDiscovered().then(loadTools).catch(() => {});
  for (;;) {
    const msg = await channel.next();
    if (msg === null) break;                     // client closed stdin
    if (Array.isArray(msg)) {
      // Batch: process in order (this layer has no cross-request state).
      const out = [];
      for (const m of msg) {
        const r = await handle(m);
        if (r) out.push(r);
      }
      if (out.length) channel.send(out);
      continue;
    }
    const r = await handle(msg);
    if (r) channel.send(r);
  }
  await cleanup();
}

main().catch(async (e) => {
  log('fatal:', e && e.stack || e);
  await cleanup();
  process.exit(1);
});
