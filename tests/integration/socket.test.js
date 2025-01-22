import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { Server } from 'socket.io';
import { createClient } from 'socket.io-client';
import { socketService } from '../../services/socketService.js';
import { cacheManager } from '../../services/cacheManager.js';
import logger from '../../services/logger.js';

describe('Socket Connection Integration Tests', () => {
  let io;
  let clientSocket;
  let mockRedis;
  const PORT = 3001;
  const SOCKET_URL = `http://localhost:${PORT}`;

  beforeEach((done) => {
    io = new Server(PORT);
    clientSocket = createClient(SOCKET_URL, {
      reconnectionDelay: 100,
      reconnectionAttempts: 3
    });
    mockRedis = {
      get: sinon.stub(),
      set: sinon.stub(),
      del: sinon.stub()
    };
    done();
  });

  afterEach(async () => {
    io.close();
    clientSocket.close();
    sinon.restore();
    await cacheManager.cleanup();
  });

  describe('Connection Management', () => {
    it('should establish connection and register event handlers', (done) => {
      // Arrange
      const userId = 'test-user-1';
      const eventHandlers = new Map();
      
      io.on('connection', (socket) => {
        socket.on('register', (data) => {
          expect(data.userId).to.equal(userId);
          done();
        });
      });

      // Act
      clientSocket.connect();
      clientSocket.emit('register', { userId });
    });

    it('should handle reconnection with exponential backoff', (done) => {
      // Arrange
      const reconnectTimes = [];
      let disconnectCount = 0;

      clientSocket.on('connect', () => {
        reconnectTimes.push(Date.now());
        if (disconnectCount < 2) {
          io.close(); // Force disconnect
          disconnectCount++;
        } else {
          // Assert
          const delays = reconnectTimes.slice(1).map((time, i) => 
            time - reconnectTimes[i]
          );
          expect(delays[1]).to.be.greaterThan(delays[0]); // Verify exponential backoff
          done();
        }
      });

      // Act
      clientSocket.connect();
    });

    it('should re-register event handlers after reconnection', (done) => {
      // Arrange
      const userId = 'test-user-2';
      const eventName = 'test_event';
      const handler = sinon.spy();
      let reconnected = false;

      io.on('connection', (socket) => {
        socket.on('register_handler', ({ event }) => {
          if (reconnected) {
            expect(event).to.equal(eventName);
            expect(handler).to.have.been.calledOnce;
            done();
          }
        });
      });

      clientSocket.on('connect', () => {
        if (!reconnected) {
          clientSocket.emit('register_handler', { 
            event: eventName,
            handler 
          });
          io.close(); // Force disconnect
          reconnected = true;
          io.listen(PORT); // Restart server
        }
      });

      // Act
      clientSocket.connect();
    });
  });

  describe('Event Handling', () => {
    it('should maintain event handlers during temporary disconnection', (done) => {
      // Arrange
      const userId = 'test-user-3';
      const eventName = 'persistent_event';
      const eventData = { message: 'test' };
      let handlerCalled = false;

      clientSocket.on(eventName, (data) => {
        expect(data).to.deep.equal(eventData);
        handlerCalled = true;
      });

      io.on('connection', (socket) => {
        if (!handlerCalled) {
          setTimeout(() => {
            io.close(); // Force disconnect
            setTimeout(() => {
              io.listen(PORT); // Restart server
              setTimeout(() => {
                io.emit(eventName, eventData);
              }, 100);
            }, 100);
          }, 100);
        } else {
          done();
        }
      });

      // Act
      clientSocket.connect();
    });

    it('should handle event emission failures during reconnection', (done) => {
      // Arrange
      const userId = 'test-user-4';
      const eventName = 'failed_event';
      const eventData = { message: 'test' };
      let emitAttempts = 0;

      clientSocket.on('connect', () => {
        if (emitAttempts === 0) {
          io.close(); // Force disconnect
          clientSocket.emit(eventName, eventData); // This should fail
          emitAttempts++;
        } else {
          expect(logger.warn).to.have.been.calledWith(
            'Event emission failed, will retry after reconnection',
            sinon.match({ 
              event: eventName,
              data: eventData,
              userId 
            })
          );
          done();
        }
      });

      // Act
      clientSocket.connect();
    });
  });

  describe('Error Recovery', () => {
    it('should handle connection timeout', (done) => {
      // Arrange
      const userId = 'test-user-5';
      clientSocket.on('connect_timeout', () => {
        expect(logger.error).to.have.been.calledWith(
          'Socket connection timeout',
          sinon.match({ userId })
        );
        done();
      });

      // Act
      clientSocket.io.opts.timeout = 100; // Set very short timeout
      clientSocket.connect();
    });

    it('should handle max reconnection attempts exceeded', (done) => {
      // Arrange
      const userId = 'test-user-6';
      let attempts = 0;

      clientSocket.on('reconnect_failed', () => {
        expect(attempts).to.equal(3); // Max attempts
        expect(logger.error).to.have.been.calledWith(
          'Max reconnection attempts reached',
          sinon.match({ userId, attempts: 3 })
        );
        done();
      });

      clientSocket.on('reconnect_attempt', () => {
        attempts++;
        io.close(); // Keep server closed to force reconnection attempts
      });

      // Act
      clientSocket.connect();
    });
  });

  describe('Cache Management', () => {
    it('should store event handlers in Redis during disconnection', async () => {
      // Arrange
      const userId = 'test-user-7';
      const handlers = [
        { event: 'event1', handler: () => {} },
        { event: 'event2', handler: () => {} }
      ];

      // Act
      await socketService.storeHandlers(userId, handlers);

      // Assert
      expect(mockRedis.set).to.have.been.calledWith(
        `socket:${userId}:handlers`,
        JSON.stringify(handlers.map(h => ({ 
          event: h.event,
          handlerId: sinon.match.string 
        }))),
        'EX',
        3600
      );
    });

    it('should restore event handlers from Redis after reconnection', async () => {
      // Arrange
      const userId = 'test-user-8';
      const storedHandlers = [
        { event: 'event1', handlerId: 'handler1' },
        { event: 'event2', handlerId: 'handler2' }
      ];

      mockRedis.get.resolves(JSON.stringify(storedHandlers));

      // Act
      const restoredHandlers = await socketService.restoreHandlers(userId);

      // Assert
      expect(restoredHandlers).to.have.length(2);
      expect(restoredHandlers[0].event).to.equal('event1');
      expect(restoredHandlers[1].event).to.equal('event2');
    });
  });
}); 