/**
 * Error Handler Middleware
 *
 * Unified error response shape.
 * No stack traces or sensitive info exposed.
 */

import type { ErrorRequestHandler } from 'express';

interface ApiError extends Error {
  statusCode?: number;
  code?: string;
}

export const errorHandler: ErrorRequestHandler = (err: ApiError, _req, res, _next) => {
  let statusCode = err.statusCode || 500;
  let code = err.code || 'INTERNAL_ERROR';

  // Detect upstream connectivity failures
  if (!err.statusCode && err.message) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes('econnrefused') ||
      msg.includes('etimedout') ||
      msg.includes('enotfound') ||
      msg.includes('fetch failed') ||
      msg.includes('network request failed')
    ) {
      statusCode = 503;
      code = 'SERVICE_UNAVAILABLE';
    }
  }

  if (statusCode >= 500) {
    console.error('[ERROR]', { code, message: err.message, statusCode });
  }

  res.status(statusCode).json({
    error: {
      code,
      message: statusCode >= 500
        ? 'An unexpected error occurred'
        : (err.message || 'An unexpected error occurred'),
    },
  });
};

export function createError(message: string, statusCode = 400, code?: string): ApiError {
  const error: ApiError = new Error(message);
  error.statusCode = statusCode;
  if (code !== undefined) error.code = code;
  return error;
}
