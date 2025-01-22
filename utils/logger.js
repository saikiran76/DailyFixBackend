const LOG_LEVELS = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug'
};

class Logger {
  constructor() {
    this.logLevel = process.env.LOG_LEVEL || LOG_LEVELS.INFO;
  }

  formatMessage(level, message, data) {
    const timestamp = new Date().toISOString();
    const logData = data ? ` ${JSON.stringify(data)}` : '';
    return `[${timestamp}] ${level.toUpperCase()}: ${message}${logData}`;
  }

  error(message, data) {
    console.error(this.formatMessage(LOG_LEVELS.ERROR, message, data));
  }

  warn(message, data) {
    if (this.shouldLog(LOG_LEVELS.WARN)) {
      console.warn(this.formatMessage(LOG_LEVELS.WARN, message, data));
    }
  }

  info(message, data) {
    if (this.shouldLog(LOG_LEVELS.INFO)) {
      console.info(this.formatMessage(LOG_LEVELS.INFO, message, data));
    }
  }

  debug(message, data) {
    if (this.shouldLog(LOG_LEVELS.DEBUG)) {
      console.debug(this.formatMessage(LOG_LEVELS.DEBUG, message, data));
    }
  }

  shouldLog(level) {
    const levels = Object.values(LOG_LEVELS);
    return levels.indexOf(level) <= levels.indexOf(this.logLevel);
  }

  setLogLevel(level) {
    if (LOG_LEVELS[level.toUpperCase()]) {
      this.logLevel = LOG_LEVELS[level.toUpperCase()];
    }
  }
}

export const logger = new Logger();
export default logger;