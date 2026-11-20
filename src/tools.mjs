// Tool-surface handling: inject the `device` parameter and add the two
// aggregator-only tools (wad_devices / wad_device_use).
//
// Why these two live here and not on the phone:
//  - The phone has no concept of "how many devices exist"; that is aggregator
//    state by definition.
//  - Users who connect directly to a phone should not see tools they cannot use,
//    so the phone's tool list stays untouched.

/** Tools that exist only in the aggregator (on top of the phone's own set). */
export const FLEET_TOOLS = [
  {
    name: 'wad_devices',
    title: 'List connected devices',
    description:
      'List every reachable WeAppDev device (USB / emulator / LAN). '
      + 'Each entry has `device` (the alias to pass to other tools), uuid, model, '
      + 'transports, appVersion, mcpVersion, mcpApiLevel (the integer used for '
      + 'compatibility), toolsCount, metaTool, and whether it is bound. '
      + 'The top-level `aggregator` field reports this server\'s own version. '
      + 'With several devices, call this first and then wad_device_use.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { group: 'core', version: '1', since: 1, aggregator: true },
  },
  {
    name: 'wad_device_use',
    title: 'Select default device',
    description:
      'Set the default device **for this MCP session only** (it affects this '
      + 'process, never other sessions or other AI clients). Afterwards every '
      + 'tool call without an explicit `device` goes there. Pass `device` on an '
      + 'individual call to override it temporarily.',
    inputSchema: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Device alias (the `device` field from wad_devices), a uuid, or http://host:port',
        },
      },
      required: ['device'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { group: 'core', version: '1', since: 1, aggregator: true },
  },
];

const DEVICE_PROP = {
  type: 'string',
  description:
    'Target device (optional): alias, uuid, or http://host:port. '
    + 'Omit to use the device pinned with wad_device_use; when exactly one '
    + 'device is online it is selected automatically.',
};

/**
 * Inject the optional `device` parameter into a phone-side tool.
 *
 * Tools that declare `additionalProperties: false` **must** get this field
 * injected, otherwise the client rejects the call during local schema
 * validation (an undeclared key appears in the arguments).
 *
 * `wad_batch` is special: its ops[].args are re-dispatched on the phone, which
 * cannot see the outer `device`, so the proxy adds `device` to each op.args
 * (see cli.mjs).
 */
export function injectDevice(tools) {
  return tools.map((t) => {
    if (!t || typeof t !== 'object') return t;
    if (t.name === 'wad_devices' || t.name === 'wad_device_use') return t;
    const schema = t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : {};
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    if (Object.prototype.hasOwnProperty.call(props, 'device')) return t;
    // catalog-only entries (no connected device reports this tool) keep a note so
    // the model does not assume it is callable
    const note = t._meta && t._meta.catalogOnly
      ? ' (no connected device reports this tool; calling it returns E_UNSUPPORTED_BY_DEVICE)'
      : '';
    return {
      ...t,
      description: note ? `${t.description}${note}` : t.description,
      inputSchema: {
        ...schema,
        type: schema.type || 'object',
        properties: { ...props, device: DEVICE_PROP },
      },
    };
  });
}
