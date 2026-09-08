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
