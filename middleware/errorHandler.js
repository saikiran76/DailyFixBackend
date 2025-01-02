import { ioEmitter } from '../utils/emitter.js';

export const errorHandler = (err, req, res, next) => {
  console.error('Error:', err);

  if (err.code === '23505') { // PostgreSQL unique violation code
    return res.status(409).json({
      error: 'Account already exists. Please try updating instead.'
    });
  }

  if (err.code === '23503') { // PostgreSQL foreign key violation
    return res.status(400).json({
      error: 'Invalid reference. Please check your input.'
    });
  }

  res.status(500).json({
    error: err.message || 'An unexpected error occurred'
  });
};