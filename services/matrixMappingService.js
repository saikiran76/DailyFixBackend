import ChannelMapping from '../models/ChannelMapping.js';
import { ioEmitter } from '../utils/emitter.js';
import { getUserIdForPlatformRoom } from './mappingService.js';

export async function createMatrixMapping(userId, sourceData, targetData) {
  try {
    const mapping = await ChannelMapping.create({
      userId,
      sourcePlatform: sourceData.platform,
      sourceChannelId: sourceData.channelId,
      sourceName: sourceData.name,
      targetPlatform: 'matrix',
      targetChannelId: targetData.roomId,
      targetName: targetData.name,
      status: 'active'
    });

    ioEmitter.emit('mapping_created', {
      userId,
      mapping: mapping.toObject()
    });

    return mapping;
  } catch (error) {
    console.error('Error creating Matrix mapping:', error);
    throw error;
  }
}

export async function getMatrixMappings(userId, platform) {
  return ChannelMapping.find({
    userId,
    sourcePlatform: platform,
    targetPlatform: 'matrix',
    status: 'active'
  }).lean();
}

export async function deleteMatrixMapping(userId, mappingId) {
  const mapping = await ChannelMapping.findOneAndUpdate(
    { _id: mappingId, userId },
    { status: 'inactive' },
    { new: true }
  );

  if (mapping) {
    ioEmitter.emit('mapping_deleted', {
      userId,
      mappingId
    });
  }

  return mapping;
} 