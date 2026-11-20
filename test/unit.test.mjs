import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPAT, META_TOOL, META_TOOL_API_LEVEL, deviceSupport, supportHint,
  buildUnionTools, aggregatorInfo,
} from '../src/capabilities.mjs';
import { SERVER_VERSION, API_LEVEL, PROTOCOLS } from '../src/version.mjs';
import { mergeDevices, DEFAULT_GATEWAY_PORT } from '../src/discover.mjs';
import { FLEET_TOOLS, injectDevice } from '../src/tools.mjs';

const rec = (over = {}) => ({ alias: 'phone', toolNames: [], mcpApiLevel: 1, ...over });

// ── version ───────────────────────────────────────────────

test('server version matches package.json', () => {
  assert.match(SERVER_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof API_LEVEL, 'number');
  assert.ok(API_LEVEL >= 1);
});

test('protocols are MCP spec revisions', () => {
  assert.ok(Array.isArray(PROTOCOLS) && PROTOCOLS.length > 0);
  for (const p of PROTOCOLS) assert.match(p, /^\d{4}-\d{2}-\d{2}$/);
});

test('apiLevel is monotonic with respect to the meta channel', () => {
  // The meta channel cannot require a level newer than the server itself claims.
  assert.ok(META_TOOL_API_LEVEL <= API_LEVEL);
});

// ── deviceSupport ─────────────────────────────────────────

test('exact tool list wins: present → ok', () => {
  const r = rec({ toolNames: ['wad_status', META_TOOL] });
  assert.equal(deviceSupport(r, 'wad_status'), COMPAT.OK);
});

test('exact tool list wins: absent → unsupported (no wasted round trip)', () => {
  const r = rec({ toolNames: ['wad_status', META_TOOL] });
  assert.equal(deviceSupport(r, 'wad_does_not_exist'), COMPAT.UNSUPPORTED);
});

test('no list but new enough → via_meta', () => {
  const r = rec({ toolNames: [], mcpApiLevel: META_TOOL_API_LEVEL });
  assert.equal(deviceSupport(r, 'anything'), COMPAT.VIA_META);
});

test('the meta channel is tried before concluding "too old"', () => {
  // A device without a tool list but with the meta channel is never declared
  // unsupported: a missing list is information we lack, not proof of age.
  const r = rec({ toolNames: [], mcpApiLevel: META_TOOL_API_LEVEL });
  assert.equal(deviceSupport(r, 'future_tool', 5), COMPAT.VIA_META);
});

test('a declared level below since, with no meta channel, is unsupported', () => {
  // apiLevel 1 predates wad_tools (since=2): no list and no meta channel there.
  const r1 = rec({ toolNames: [], mcpApiLevel: 1 });
  assert.equal(deviceSupport(r1, 'future_tool', 99), COMPAT.UNSUPPORTED);
  // apiLevel 2+ carries the meta channel even when the tool list is empty.
  const r2 = rec({ toolNames: [], mcpApiLevel: META_TOOL_API_LEVEL });
  assert.equal(deviceSupport(r2, 'future_tool', 99), COMPAT.VIA_META);
  const saved = META_TOOL_API_LEVEL;
  assert.equal(saved, 2);                     // constant untouched
});

test('no list and unknown level → unknown (forward optimistically)', () => {
  const r = rec({ toolNames: [], mcpApiLevel: 0 });
  assert.equal(deviceSupport(r, 'anything'), COMPAT.UNKNOWN);
});

test('null record → unknown', () => {
  assert.equal(deviceSupport(null, 'x'), COMPAT.UNKNOWN);
});

test('supportHint mentions the device and the meta tool when available', () => {
  const withMeta = supportHint(rec({ toolNames: [META_TOOL], mcpVersion: '1.0.0' }), 'wad_x');
  assert.match(withMeta, /phone/);
  assert.match(withMeta, /wad_x/);
  assert.match(withMeta, /wad_tools/);

  const noMeta = supportHint(rec({ toolNames: [], mcpVersion: '1.0.0' }), 'wad_x');
  assert.match(noMeta, /Upgrade/);
});

// ── buildUnionTools ───────────────────────────────────────

test('union keeps every device tool and annotates support', () => {
  const perDevice = [
    { alias: 'a', tools: [{ name: 'wad_status', inputSchema: { properties: {} } }] },
    { alias: 'b', tools: [{ name: 'wad_status', inputSchema: { properties: {} } },
      { name: 'wad_extra', inputSchema: { properties: {} } }] },
  ];
  const union = buildUnionTools(perDevice, []);
  const byName = new Map(union.map((t) => [t.name, t]));
  assert.deepEqual(byName.get('wad_status')._meta.devices, ['a', 'b']);
  assert.deepEqual(byName.get('wad_extra')._meta.devices, ['b']);
  assert.deepEqual(byName.get('wad_extra')._meta.unsupportedBy, ['a']);
});

test('richer schema wins when two devices describe the same tool', () => {
  const thin = { name: 'wad_x', inputSchema: { properties: { a: {} } } };
  const rich = { name: 'wad_x', inputSchema: { properties: { a: {}, b: {} } } };
  const union = buildUnionTools([
    { alias: 'thin', tools: [thin] },
    { alias: 'rich', tools: [rich] },
  ], []);
  assert.deepEqual(Object.keys(union[0].inputSchema.properties).sort(), ['a', 'b']);
});

test('catalog fills in tools that no device reports, marked catalogOnly', () => {
  const union = buildUnionTools(
    [{ alias: 'a', tools: [{ name: 'wad_status', inputSchema: { properties: {} } }] }],
    [{ name: 'wad_future', group: 'core', since: 1 }],
  );
  const future = union.find((t) => t.name === 'wad_future');
  assert.ok(future);
  assert.equal(future._meta.catalogOnly, true);
  assert.deepEqual(future._meta.devices, []);
  assert.match(future._meta.note, /E_UNSUPPORTED_BY_DEVICE/);
});

test('union output is sorted by group then name', () => {
  const union = buildUnionTools([
    { alias: 'a', tools: [
      { name: 'zeta', _meta: { group: 'b' }, inputSchema: { properties: {} } },
      { name: 'alpha', _meta: { group: 'b' }, inputSchema: { properties: {} } },
      { name: 'beta', _meta: { group: 'a' }, inputSchema: { properties: {} } },
    ] },
  ], []);
  assert.deepEqual(union.map((t) => t.name), ['beta', 'alpha', 'zeta']);
});

test('aggregator identity is self-consistent', () => {
  const info = aggregatorInfo();
  assert.equal(info.version, SERVER_VERSION);
  assert.equal(info.apiLevel, API_LEVEL);
  assert.equal(info.role, 'aggregator');
});

// ── injectDevice ──────────────────────────────────────────

test('every non-fleet tool gains an optional device parameter', () => {
  const tools = injectDevice([
    { name: 'wad_status', inputSchema: { type: 'object', properties: {} } },
  ]);
  assert.ok(tools[0].inputSchema.properties.device);
  assert.deepEqual(tools[0].inputSchema.required ?? [], []);
});

test('additionalProperties:false tools still get device (client-side validation)', () => {
  const tools = injectDevice([
    { name: 'wad_x', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  ]);
  assert.ok(tools[0].inputSchema.properties.device);
  assert.equal(tools[0].inputSchema.additionalProperties, false);
});

test('fleet tools are left untouched by injectDevice', () => {
  const tools = injectDevice(FLEET_TOOLS);
  assert.deepEqual(tools, FLEET_TOOLS);
  // wad_devices takes no arguments at all; wad_device_use declares its own `device`.
  const byName = new Map(FLEET_TOOLS.map((t) => [t.name, t]));
  assert.deepEqual(byName.get('wad_devices').inputSchema.properties, {});
  assert.deepEqual(byName.get('wad_device_use').inputSchema.required, ['device']);
});

test('an existing device property is not overwritten', () => {
  const tools = injectDevice([
    { name: 'wad_x', inputSchema: { properties: { device: { type: 'string', description: 'mine' } } } },
  ]);
  assert.equal(tools[0].inputSchema.properties.device.description, 'mine');
});

test('catalog-only tools explain why they are unavailable', () => {
  const tools = injectDevice([
    { name: 'wad_x', description: 'base.', _meta: { catalogOnly: true },
      inputSchema: { properties: {} } },
  ]);
  assert.match(tools[0].description, /E_UNSUPPORTED_BY_DEVICE/);
});

// ── mergeDevices ──────────────────────────────────────────

test('usb and lan for the same uuid merge into one record, usb preferred', () => {
  const merged = mergeDevices([
    { uuid: 'wad-abc', baseUrl: 'http://10.0.0.5:9400', transport: 'lan' },
    { uuid: 'wad-abc', baseUrl: 'http://127.0.0.1:5555', transport: 'usb', serial: 'S1' },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].transports, ['lan', 'usb']);
  assert.equal(merged[0].baseUrl, 'http://127.0.0.1:5555');
  assert.equal(merged[0].urls.lan, 'http://10.0.0.5:9400');
});

test('different uuids stay separate', () => {
  const merged = mergeDevices([
    { uuid: 'wad-a', baseUrl: 'http://1.1.1.1:9400', transport: 'lan' },
    { uuid: 'wad-b', baseUrl: 'http://2.2.2.2:9400', transport: 'lan' },
  ]);
  assert.equal(merged.length, 2);
});

test('without a uuid, records fall back to serial or url', () => {
  const merged = mergeDevices([
    { uuid: '', serial: 'S1', baseUrl: 'http://127.0.0.1:1', transport: 'usb' },
    { uuid: '', serial: '', baseUrl: 'http://10.0.0.9:9400', transport: 'lan' },
  ]);
  assert.equal(merged.length, 2);
});

test('default gateway port is the documented default', () => {
  assert.equal(DEFAULT_GATEWAY_PORT, 9400);
});
