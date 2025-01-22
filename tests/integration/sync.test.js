import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { whatsappEntityService } from '../../services/whatsappEntityService.js';
import { cacheManager } from '../../services/cacheManager.js';
import { MessageBatchProcessor } from '../../utils/messageBatchProcessor.js';
import logger from '../../services/logger.js';

describe('Contact and Message Sync Integration Tests', () => {
  let mockSocket;
  let mockRedis;
  let mockDB;

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
    mockDB = {
      collection: sinon.stub().returnsThis(),
      find: sinon.stub().returnsThis(),
      findOne: sinon.stub(),
      insertMany: sinon.stub(),
      updateMany: sinon.stub()
    };
  });

  afterEach(async () => {
    sinon.restore();
    await cacheManager.cleanup();
  });

  describe('Contact Synchronization', () => {
    it('should sync contacts and cache results', async () => {
      // Arrange
      const userId = 'test-user-1';
      const contacts = [
        { id: 'contact1', name: 'Test Contact 1' },
        { id: 'contact2', name: 'Test Contact 2' }
      ];

      sinon.stub(whatsappEntityService, 'fetchContacts').resolves(contacts);
      mockRedis.get.resolves(null); // No cached contacts

      // Act
      const result = await whatsappEntityService.syncContacts(userId);

      // Assert
      expect(result).to.deep.equal(contacts);
      expect(mockRedis.set).to.have.been.calledWith(
        `whatsapp:${userId}:contacts`,
        JSON.stringify(contacts),
        'EX',
        300 // 5 minutes cache
      );
      expect(mockDB.insertMany).to.have.been.calledWith(
        sinon.match(contacts.map(c => ({ ...c, userId })))
      );
    });

    it('should return cached contacts if available', async () => {
      // Arrange
      const userId = 'test-user-2';
      const cachedContacts = [
        { id: 'contact1', name: 'Cached Contact 1' }
      ];

      mockRedis.get.resolves(JSON.stringify(cachedContacts));

      // Act
      const result = await whatsappEntityService.getContacts(userId);

      // Assert
      expect(result).to.deep.equal(cachedContacts);
      expect(whatsappEntityService.fetchContacts).to.not.have.been.called;
    });

    it('should handle contact sync errors', async () => {
      // Arrange
      const userId = 'test-user-3';
      sinon.stub(whatsappEntityService, 'fetchContacts').rejects(
        new Error('Failed to fetch contacts')
      );

      // Act
      try {
        await whatsappEntityService.syncContacts(userId);
        expect.fail('Should have thrown an error');
      } catch (error) {
        // Assert
        expect(error.message).to.equal('Failed to fetch contacts');
        expect(logger.error).to.have.been.calledWith(
          'Contact sync failed',
          sinon.match({ userId, error: 'Failed to fetch contacts' })
        );
      }
    });
  });

  describe('Message Synchronization', () => {
    let batchProcessor;

    beforeEach(() => {
      batchProcessor = new MessageBatchProcessor({
        batchSize: 50,
        onBatchProcess: sinon.stub().resolves()
      });
    });

    it('should process messages in batches', async () => {
      // Arrange
      const userId = 'test-user-4';
      const messages = Array(100).fill().map((_, i) => ({
        id: `msg${i}`,
        text: `Message ${i}`,
        timestamp: Date.now() + i
      }));

      sinon.stub(whatsappEntityService, 'fetchMessages').resolves(messages);

      // Act
      await batchProcessor.processMessages(messages);

      // Assert
      expect(batchProcessor.onBatchProcess).to.have.been.calledTwice;
      expect(batchProcessor.onBatchProcess.firstCall.args[0]).to.have.length(50);
      expect(batchProcessor.onBatchProcess.secondCall.args[0]).to.have.length(50);
    });

    it('should handle message sync interruption', async () => {
      // Arrange
      const userId = 'test-user-5';
      const messages = Array(30).fill().map((_, i) => ({
        id: `msg${i}`,
        text: `Message ${i}`,
        timestamp: Date.now() + i
      }));

      sinon.stub(whatsappEntityService, 'fetchMessages').resolves(messages);
      batchProcessor.onBatchProcess.onFirstCall().rejects(
        new Error('Sync interrupted')
      );

      // Act
      try {
        await batchProcessor.processMessages(messages);
        expect.fail('Should have thrown an error');
      } catch (error) {
        // Assert
        expect(error.message).to.equal('Sync interrupted');
        expect(mockRedis.set).to.have.been.calledWith(
          `whatsapp:${userId}:pending_messages`,
          JSON.stringify(messages.slice(50)),
          'EX',
          3600
        );
      }
    });

    it('should resume message sync from last position', async () => {
      // Arrange
      const userId = 'test-user-6';
      const pendingMessages = Array(50).fill().map((_, i) => ({
        id: `msg${i}`,
        text: `Pending Message ${i}`,
        timestamp: Date.now() + i
      }));

      mockRedis.get.resolves(JSON.stringify(pendingMessages));

      // Act
      await batchProcessor.resumeProcessing(userId);

      // Assert
      expect(batchProcessor.onBatchProcess).to.have.been.calledWith(pendingMessages);
      expect(mockRedis.del).to.have.been.calledWith(
        `whatsapp:${userId}:pending_messages`
      );
    });
  });

  describe('Error Recovery', () => {
    it('should retry failed message processing', async () => {
      // Arrange
      const userId = 'test-user-7';
      const messages = [
        { id: 'retry1', text: 'Retry Message 1' },
        { id: 'retry2', text: 'Retry Message 2' }
      ];

      const batchProcessor = new MessageBatchProcessor({
        batchSize: 2,
        maxRetries: 3,
        onBatchProcess: sinon.stub()
          .onFirstCall().rejects(new Error('Processing failed'))
          .onSecondCall().resolves()
      });

      // Act
      await batchProcessor.processMessages(messages);

      // Assert
      expect(batchProcessor.onBatchProcess).to.have.been.calledTwice;
      expect(logger.warn).to.have.been.calledWith(
        'Batch processing failed, retrying',
        sinon.match({ attempt: 1, messages: messages })
      );
    });

    it('should handle permanent failures after max retries', async () => {
      // Arrange
      const userId = 'test-user-8';
      const messages = [
        { id: 'fail1', text: 'Failed Message 1' }
      ];

      const batchProcessor = new MessageBatchProcessor({
        batchSize: 1,
        maxRetries: 3,
        onBatchProcess: sinon.stub().rejects(new Error('Permanent failure'))
      });

      // Act
      try {
        await batchProcessor.processMessages(messages);
        expect.fail('Should have thrown an error');
      } catch (error) {
        // Assert
        expect(error.message).to.equal('Permanent failure');
        expect(batchProcessor.onBatchProcess).to.have.been.calledThrice;
        expect(logger.error).to.have.been.calledWith(
          'Message processing failed permanently',
          sinon.match({ 
            userId,
            messages,
            error: 'Permanent failure',
            retryCount: 3
          })
        );
      }
    });
  });
}); 