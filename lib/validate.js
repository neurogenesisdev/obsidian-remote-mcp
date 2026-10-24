'use strict';

// A small check against each tool's advertised JSON Schema.
//
// The MCP SDK passes arguments through untouched, so without this a missing
// required field surfaces as a TypeError from deep inside a handler. Only the
// top level is checked, which is where clients actually get it wrong.

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function check(schema, args, toolName) {
  const properties = (schema && schema.properties) || {};
  const required = (schema && schema.required) || [];

  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      throw new Error(`${toolName}: "${key}" is required.`);
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (!spec || value === undefined || value === null) continue;

    if (spec.type && typeOf(value) !== spec.type) {
      // JSON has one number type, so an integer arriving where a number is
      // declared is fine; anything else is a real mismatch worth reporting.
      if (!(spec.type === 'number' && typeof value === 'number')) {
        throw new Error(`${toolName}: "${key}" must be a ${spec.type}, got ${typeOf(value)}.`);
      }
    }
    if (spec.enum && !spec.enum.includes(value)) {
      throw new Error(`${toolName}: "${key}" must be one of ${spec.enum.join(', ')}, got "${value}".`);
    }
    if (spec.type === 'array' && spec.items && spec.items.type) {
      const bad = value.findIndex((item) => typeOf(item) !== spec.items.type);
      if (bad !== -1) {
        throw new Error(`${toolName}: "${key}[${bad}]" must be a ${spec.items.type}, got ${typeOf(value[bad])}.`);
      }
    }
  }
}

module.exports = { check };
