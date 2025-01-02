import { MemoryCryptoStore } from 'matrix-js-sdk';

export class NodeCryptoStore extends MemoryCryptoStore {
  constructor() {
    super();
    this.store = new Map();
  }

  async doTxn(mode, stores, func) {
    return await func(this);
  }

  getItem(key) {
    return this.store.get(key);
  }

  setItem(key, value) {
    this.store.set(key, value);
  }

  removeItem(key) {
    this.store.delete(key);
  }

  getEndToEndDeviceData() {
    return this.store.get('deviceData');
  }

  setEndToEndDeviceData(deviceData) {
    this.store.set('deviceData', deviceData);
  }

  getEndToEndRoomKeyBackup() {
    return this.store.get('roomKeyBackup');
  }

  setEndToEndRoomKeyBackup(roomKeyBackup) {
    this.store.set('roomKeyBackup', roomKeyBackup);
  }

  getDeviceData() {
    return this.store.get('deviceData');
  }

  setDeviceData(data) {
    this.store.set('deviceData', data);
  }

  getSessionBackupPrivateKey() {
    return this.store.get('backupKey');
  }

  setSessionBackupPrivateKey(key) {
    this.store.set('backupKey', key);
  }
}