// Validation middleware for request parameters
export const validateRequest = (requiredParams = []) => {
  return (req, res, next) => {
    const missingParams = [];

    // Check params in URL parameters
    requiredParams.forEach(param => {
      if (req.params[param] === undefined && 
          req.body[param] === undefined && 
          req.query[param] === undefined) {
        missingParams.push(param);
      }
    });

    if (missingParams.length > 0) {
      return res.status(400).json({
        status: 'error',
        message: `Missing required parameters: ${missingParams.join(', ')}`
      });
    }

    // Validate numeric parameters
    const numericParams = ['contactId', 'limit'];
    numericParams.forEach(param => {
      const value = req.params[param] || req.body[param] || req.query[param];
      if (value !== undefined) {
        const num = parseInt(value);
        if (isNaN(num)) {
          return res.status(400).json({
            status: 'error',
            message: `Parameter ${param} must be a number`
          });
        }
      }
    });

    // Validate array parameters
    const arrayParams = ['messageIds'];
    arrayParams.forEach(param => {
      const value = req.body[param];
      if (value !== undefined && !Array.isArray(value)) {
        return res.status(400).json({
          status: 'error',
          message: `Parameter ${param} must be an array`
        });
      }
    });

    // Validate enum parameters
    const enumParams = {
      status: ['pending', 'approved', 'rejected']
    };

    Object.entries(enumParams).forEach(([param, validValues]) => {
      const value = req.body[param];
      if (value !== undefined && !validValues.includes(value)) {
        return res.status(400).json({
          status: 'error',
          message: `Invalid ${param}. Must be one of: ${validValues.join(', ')}`
        });
      }
    });

    next();
  };
}; 