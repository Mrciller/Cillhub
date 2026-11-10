/** @typedef {{open?: boolean, userOnly?: boolean, botOnly?: boolean, admin?: boolean,
 * multipart?: boolean, maxBody?: number, when?: Function,
 * rateLimit?: {max: number, windowMs: number}}} RouteOptions */

// Fail at startup when a route declares a policy the dispatcher cannot enforce.
export function compileRoute([method, pattern, handler, opts = {}]) {
  const fail = message => { throw new TypeError(`${method} ${pattern}: ${message}`); };
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) fail('invalid route options');
  const flags = new Set(['open', 'userOnly', 'botOnly', 'admin', 'multipart']);
  for (const [key, value] of Object.entries(opts)) {
    if (flags.has(key)) { if (typeof value !== 'boolean') fail(`${key} must be boolean`); }
    else if (key === 'maxBody') { if (!Number.isSafeInteger(value) || value < 1) fail('invalid maxBody'); }
    else if (key === 'when') { if (typeof value !== 'function') fail('invalid when'); }
    else if (key === 'rateLimit') {
      if (!value || Object.keys(value).some(k => !['max', 'windowMs'].includes(k))
        || !Number.isSafeInteger(value.max) || value.max < 1
        || !Number.isSafeInteger(value.windowMs) || value.windowMs < 1) fail('invalid rateLimit');
    } else fail(`unsupported option ${key}`);
  }
  if (opts.open && (opts.userOnly || opts.botOnly || opts.admin)) fail('open route cannot require an account');
  if (opts.userOnly && opts.botOnly) fail('conflicting account types');
  if (typeof handler !== 'function') fail('invalid handler');
  return { method, pattern, handler, ...opts, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`) };
}
