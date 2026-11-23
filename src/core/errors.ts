/** Typed API errors. `code` is stable for contract tests. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (msg: string, detail?: Record<string, unknown>) =>
  new ApiError(400, "bad_request", msg, detail);
export const unauthorized = (msg = "authentication required") => new ApiError(401, "unauthorized", msg);
export const forbidden = (code: string, msg: string, detail?: Record<string, unknown>) =>
  new ApiError(403, code, msg, detail);
export const notFound = (what = "resource") => new ApiError(404, "not_found", `${what} not found`);
export const conflict = (code: string, msg: string, detail?: Record<string, unknown>) =>
  new ApiError(409, code, msg, detail);
export const unprocessable = (code: string, msg: string, detail?: Record<string, unknown>) =>
  new ApiError(422, code, msg, detail);
export const rateLimited = (msg: string, retryAfterSeconds: number) =>
  new ApiError(429, "rate_limited", msg, { retryAfterSeconds });
