import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { matrixWhatsAppService } from '../../services/matrixWhatsAppService.js';
import { cacheManager } from '../../services/cacheManager.js';
import logger from '../../services/logger.js';

describe('WhatsApp Status Integration Tests', () => {
  let mockSocket;
  let mockRedis;

  beforeEach(() => {
    mockSocket = {
      emit: sinon.spy(),
      on: sinon.spy()
    };
    mockRedis = {
      get: sinon.stub(),
      set: sinon.stub(),
      del: sinon.stub()
    };
  });

  afterEach(async () => {
    sinon.restore();
    await cacheManager.cleanup();
  });

  describe('Status Check Flow', () => {
    it('should return cached status if available and not expired', async () => {
      // Arrange
      const userId = 'test-user-1';
      const cachedStatus = {
        status: 'active',
        bridgeRoomId: 'test-bridge-room',
        lastUpdated: Date.now(),
        needsRestore: false
      };

      mockRedis.get.resolves(JSON.stringify(cachedStatus));
      sinon.stub(cacheManager, 'getCache').resolves(cachedStatus);

      // Act
      const status = await matrixWhatsAppService.getStatus(userId);

      // Assert
      expect(status).to.deep.equal(cachedStatus);
      expect(mockRedis.get).to.have.been.calledWith(
        `whatsapp:${userId}:status`
      );
    });

    it('should fetch fresh status if cache is expired', async () => {
      // Arrange
      const userId = 'test-user-2';
      const expiredStatus = {
        status: 'active',
        bridgeRoomId: 'test-bridge-room',
        lastUpdated: Date.now() - 3600001, // Expired by 1ms
        needsRestore: false
      };

      const freshStatus = {
        ...expiredStatus,
        lastUpdated: Date.now()
      };

      mockRedis.get.resolves(JSON.stringify(expiredStatus));
      sinon.stub(matrixWhatsAppService, 'checkBridgeStatus').resolves(freshStatus);

      // Act
      const status = await matrixWhatsAppService.getStatus(userId);

      // Assert
      expect(status).to.deep.equal(freshStatus);
      expect(mockRedis.set).to.have.been.calledWith(
        `whatsapp:${userId}:status`,
        JSON.stringify(freshStatus),
        'EX',
        3600
      );
    });

    it('should handle error status with shorter cache duration', async () => {
      // Arrange
      const userId = 'test-user-3';
      const errorStatus = {
        status: 'error',
        error: 'Connection failed',
        lastUpdated: Date.now(),
        needsRestore: true
      };

      sinon.stub(matrixWhatsAppService, 'checkBridgeStatus').resolves(errorStatus);

      // Act
      const status = await matrixWhatsAppService.getStatus(userId);

      // Assert
      expect(status).to.deep.equal(errorStatus);
      expect(mockRedis.set).to.have.been.calledWith(
        `whatsapp:${userId}:status`,
        JSON.stringify(errorStatus),
        'EX',
        300 // 5 minutes for error states
      );
    });
  });

  describe('Bridge Room Status', () => {
    it('should detect active bridge room and set status', async () => {
      // Arrange
      const userId = 'test-user-4';
      const bridgeRoomId = 'active-bridge-room';
      
      sinon.stub(matrixWhatsAppService, 'findBridgeRoom').resolves(bridgeRoomId);
      sinon.stub(matrixWhatsAppService, 'checkBridgeStatus').resolves({
        status: 'active',
        bridgeRoomId,
        needsRestore: false
      });

      // Act
      const status = await matrixWhatsAppService.getStatus(userId);

      // Assert
      expect(status.status).to.equal('active');
      expect(status.bridgeRoomId).to.equal(bridgeRoomId);
      expect(status.needsRestore).to.be.false;
    });

    it('should handle inactive bridge room', async () => {
      // Arrange
      const userId = 'test-user-5';
      const bridgeRoomId = 'inactive-bridge-room';
      
      sinon.stub(matrixWhatsAppService, 'findBridgeRoom').resolves(bridgeRoomId);
      sinon.stub(matrixWhatsAppService, 'checkBridgeStatus').resolves({
        status: 'inactive',
        bridgeRoomId,
        needsRestore: true
      });

      // Act
      const status = await matrixWhatsAppService.getStatus(userId);

      // Assert
      expect(status.status).to.equal('inactive');
      expect(status.bridgeRoomId).to.equal(bridgeRoomId);
      expect(status.needsRestore).to.be.true;
    });
  });

  describe('Error Handling', () => {
    it('should handle bridge room not found', async () => {
      // Arrange
      const userId = 'test-user-6';
      sinon.stub(matrixWhatsAppService, 'findBridgeRoom').resolves(null);

      // Act
      const status = await matrixWhatsAppService.getStatus(userId);

      // Assert
      expect(status.status).to.equal('inactive');
      expect(status.bridgeRoomId).to.be.null;
      expect(status.error).to.equal('Bridge room not found');
    });

    it('should handle bridge status check failure', async () => {
      // Arrange
      const userId = 'test-user-7';
      const bridgeRoomId = 'error-bridge-room';
      
      sinon.stub(matrixWhatsAppService, 'findBridgeRoom').resolves(bridgeRoomId);
      sinon.stub(matrixWhatsAppService, 'checkBridgeStatus').rejects(
        new Error('Failed to check bridge status')
      );

      // Act
      const status = await matrixWhatsAppService.getStatus(userId);

      // Assert
      expect(status.status).to.equal('error');
      expect(status.bridgeRoomId).to.equal(bridgeRoomId);
      expect(status.error).to.equal('Failed to check bridge status');
      expect(logger.error).to.have.been.calledWith(
        'Bridge status check failed',
        sinon.match({ userId, bridgeRoomId })
      );
    });
  });
}); 