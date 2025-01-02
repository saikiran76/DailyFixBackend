import ChannelMapping from '../models/ChannelMapping.js';
import Account from '../models/Account.js';

export async function getUserIdForPlatformRoom(platform, roomId) {
  let mapping = await ChannelMapping.findOne({platform, roomId}).lean();
  if (mapping) return mapping.userId;

  // If no mapping exists, attempt to find an account for that platform:
  const anyAcc=await Account.findOne({platform}).lean();
  if(!anyAcc) {
    console.warn(`No account found for ${platform}, cannot map user. Using first user found or fail.`);
    // If truly no user found for that platform, fallback:
    const fallbackAcc=await Account.findOne({}).lean();
    if(!fallbackAcc) {
      console.error('No users at all, cannot map userId. Returning null.');
      return null;
    }
    await ChannelMapping.create({platform, roomId, userId:fallbackAcc.userId});
    return fallbackAcc.userId;
  }

  // Create a mapping entry now for the found account:
  await ChannelMapping.create({platform, roomId, userId:anyAcc.userId, team_id:anyAcc.credentials.team_id||undefined});
  return anyAcc.userId;
}
