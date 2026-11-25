/**
 * An error a tool raises on purpose, carrying the HTTP status the route
 * should answer with. Anything else thrown by a tool is answered as 400
 * (the historical behaviour of the /tools/* routes).
 */
export class ToolError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'ToolError';
    this.status = status;
    if (code) this.code = code;
  }
}

export const forbidden = (message, code = 'forbidden') => new ToolError(403, message, code);
export const badRequest = (message, code = 'bad_request') => new ToolError(400, message, code);
export const tooLarge = (message, code = 'too_large') => new ToolError(413, message, code);
