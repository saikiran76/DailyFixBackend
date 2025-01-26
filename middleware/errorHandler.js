import { logger } from '../utils/logger.js';

// Custom error class for API errors
export class APIError extends Error {
  constructor(message, statusCode = 500, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

// Error handler middleware
export const errorHandler = (err, req, res, next) => {
  logger.error('[Error Handler]', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    userId: req.user?.id
  });

  // Handle known error types
  if (err instanceof APIError) {
    return res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
      code: err.statusCode,
      details: err.details
    });
  }

  // Handle Supabase errors
  if (err.code && err.code.startsWith('23')) {
    return res.status(400).json({
      status: 'error',
      message: 'Database constraint violation',
      code: 400,
      details: err.message
    });
  }

  // Handle validation errors
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      status: 'error',
      message: 'Validation failed',
      code: 400,
      details: err.details
    });
  }

  // Default error response
  res.status(500).json({
    status: 'error',
    message: 'Internal server error',
    code: 500,
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
};