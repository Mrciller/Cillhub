export class HttpError extends Error {
  constructor(status, code, message, errors) {
    super(message);
    this.status = status;
    this.body = errors ? { code, message, errors } : { code, message };
  }
}

export const unauthorized = () => new HttpError(401, 40001, '401: Unauthorized');
export const missingAccess = () => new HttpError(403, 50001, 'Missing Access');
export const missingPermissions = () => new HttpError(403, 50013, 'Missing Permissions');
export const notFound = (code, what) => new HttpError(404, code, `Unknown ${what}`);
export const invalid = (field, code, message) =>
  new HttpError(400, 50035, 'Invalid Form Body', { [field]: { _errors: [{ code, message }] } });

export function str(body, field, min, max, trim = true) {
  let v = body?.[field];
  if (typeof v !== 'string') throw invalid(field, 'BASE_TYPE_REQUIRED', 'This field is required and must be a string.');
  if (trim) v = v.trim();
  if (v.length < min || v.length > max) throw invalid(field, 'BASE_TYPE_BAD_LENGTH', `Must be between ${min} and ${max} in length.`);
  return v;
}

// one plain address: no list separators, quotes, brackets, whitespace or control characters a mailer could split on
export function emailField(body, field = 'email') {
  const v = str(body, field, 3, 254);
  if (!/^[^@\s,;<>"()\x00-\x1f\x7f-\x9f]+@[^@\s,;<>"()\x00-\x1f\x7f-\x9f]+$/.test(v)) throw invalid(field, 'EMAIL_TYPE_INVALID_EMAIL', 'Not a well formed email address.');
  return v;
}

export function intParam(query, name, fallback, min, max) {
  if (!query.has(name)) return fallback;
  const n = Number(query.get(name));
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(name, 'NUMBER_TYPE_COERCE', `Must be an integer between ${min} and ${max}.`);
  return n;
}

export function idParam(query, name) {
  const v = query.get(name);
  if (v !== null && !/^\d{1,19}$/.test(v)) throw invalid(name, 'NUMBER_TYPE_COERCE', 'Value is not a snowflake.');
  return v;
}

export function snowflakeField(body, field) {
  const v = body?.[field];
  if (typeof v !== 'string' || !/^\d{1,19}$/.test(v)) throw invalid(field, 'NUMBER_TYPE_COERCE', 'Value is not a snowflake.');
  return v;
}

export function int(body, field, min, max) {
  const v = body?.[field];
  if (!Number.isInteger(v) || v < min || v > max) throw invalid(field, 'NUMBER_TYPE_COERCE', `Must be an integer between ${min} and ${max}.`);
  return v;
}

export function bool(body, field) {
  if (typeof body?.[field] !== 'boolean') throw invalid(field, 'BASE_TYPE_BOOLEAN', 'Must be a boolean.');
  return body[field];
}

export function list(body, field) {
  const v = field === undefined ? body : body?.[field];
  if (!Array.isArray(v)) throw invalid(field ?? '_root', 'BASE_TYPE_ARRAY', 'Must be an array.');
  return v;
}

export function optStr(body, field, min, max) {
  if (body?.[field] == null) return null;
  return str(body, field, min, max) || null;
}

// the documented rate limit body; retry_after in seconds
export function rateLimited(seconds, code = 20016) {
  const e = new HttpError(429, code, 'You are being rate limited.');
  Object.assign(e.body, { retry_after: Math.ceil(seconds * 1000) / 1000, global: false });
  return e;
}

export function snowflakes(body, field, max) {
  const v = list(body, field);
  if (v.length > max) throw invalid(field, 'BASE_TYPE_MAX_LENGTH', `Must be ${max} or fewer in length.`);
  if (!v.every(x => typeof x === 'string' && /^\d{1,19}$/.test(x))) throw invalid(field, 'NUMBER_TYPE_COERCE', 'Values must be snowflakes.');
  return [...new Set(v)];
}
