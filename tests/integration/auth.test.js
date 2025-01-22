import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { createClient } from '@supabase/supabase-js';
import matrixWhatsAppService from '../../services/matrixWhatsAppService.js';
import cacheManager from '../../services/cacheManager.js';
import logger from '../../services/logger.js';

describe('Authentication Flow Integration Tests', () => {
  let supabaseClient;
  let mockSocket;

  beforeEach(() => {
    supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    mockSocket = {
      emit: sinon.spy(),
      on: sinon.spy()
    };
  });

  afterEach(async () => {
    sinon.restore();
    await cacheManager.cleanup();
  });

  describe('Existing User Login (Type-1: With WhatsApp)', () => {
    it('should redirect to dashboard if user has bridge_room_id', async () => {
      const userId = 'test-user-1';
      const bridgeRoomId = 'test-bridge-room';
      
      // Mock cache to return existing bridge room
      await cacheManager.set(`whatsapp:${userId}:bridge_room`, bridgeRoomId);
      
      // Mock WhatsApp status check
      sinon.stub(matrixWhatsAppService, 'getStatus').resolves({
        status: 'active',
        bridgeRoomId,
        needsRestore: false
      });

      const status = await matrixWhatsAppService.getStatus(userId);
      
      expect(status.bridgeRoomId).to.equal(bridgeRoomId);
      expect(status.status).to.equal('active');
      expect(status.needsRestore).to.be.false;
    });
  });

  describe('Existing User Login (Type-2: Without WhatsApp)', () => {
    it('should show QR code if user has no bridge_room_id', async () => {
      const userId = 'test-user-2';
      
      // Mock WhatsApp status check for new connection
      sinon.stub(matrixWhatsAppService, 'getStatus').resolves({
        status: 'inactive',
        bridgeRoomId: null,
        needsRestore: false
      });

      // Mock connect function
      sinon.stub(matrixWhatsAppService, 'connect').resolves({
        success: true,
        qrCode: 'test-qr-code'
      });

      const status = await matrixWhatsAppService.getStatus(userId);
      expect(status.bridgeRoomId).to.be.null;
      expect(status.status).to.equal('inactive');

      const connection = await matrixWhatsAppService.connect(userId);
      expect(connection.success).to.be.true;
      expect(connection.qrCode).to.exist;
      expect(mockSocket.emit.calledWith('whatsapp:qr_code')).to.be.true;
    });
  });

  describe('New User Signup', () => {
    it('should create new user and show QR code', async () => {
      const userId = 'test-user-3';
      
      // Mock user creation
      sinon.stub(supabaseClient.auth, 'signUp').resolves({
        data: { user: { id: userId } },
        error: null
      });

      // Mock WhatsApp connection
      sinon.stub(matrixWhatsAppService, 'connect').resolves({
        success: true,
        qrCode: 'test-qr-code'
      });

      const signupResult = await supabaseClient.auth.signUp({
        email: 'test@example.com',
        password: 'password123'
      });

      expect(signupResult.data.user.id).to.equal(userId);

      const connection = await matrixWhatsAppService.connect(userId);
      expect(connection.success).to.be.true;
      expect(connection.qrCode).to.exist;
      expect(mockSocket.emit.calledWith('whatsapp:qr_code')).to.be.true;
    });
  });
}); 