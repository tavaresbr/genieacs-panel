export function createResponse(message, data = null, code = null) {
  const response = {
    success: true,
    message
  };
  if (code) {
    response.code = code;
  }
  if (data !== null) {
    response.data = data;
  }
  return response;
}

/**
 * Internal error text is attached only when the deployment explicitly asks for
 * it. APP_ENV defaults to 'development', so testing for "not production" would
 * leak stack messages from every deployment that never sets the variable.
 */
export function createErrorResponse(message, error = null, code = null) {
  const response = {
    success: false,
    message
  };
  if (code) {
    response.code = code;
  }
  if (error && process.env.APP_ENV === 'development') {
    response.error = error;
  }
  return response;
}

/**
 * Milliseconds from a timestamp, whichever shape the driver returned.
 *
 * `pg` and `mysql2` hand back a `Date`; `better-sqlite3` hands back an integer
 * or a string. Every comparison against a stored timestamp goes through here
 * so the three do not have to be remembered at each call site.
 */
export function timestampMs(value) {
  if (value === null || value === undefined) return Number.NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Date.parse(String(value));
}
