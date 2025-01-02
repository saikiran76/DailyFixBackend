import { WebClient } from '@slack/web-api';
import Account from '../models/Account.js';
import Message from '../models/Message.js';
import { applyRulesToMessage } from './rulesService.js';
import ChannelMapping from '../models/ChannelMapping.js';
import { ioEmitter } from '../utils/emitter.js';

let slackUserCache=new Map();

// On-demand init:
export async function initializeSlackClientForUser(userId) {
  const slackAcc = await Account.findOne({userId,platform:'slack'}).lean();
  if(!slackAcc||!slackAcc.credentials.access_token||!slackAcc.credentials.team_id) return null;
  return {team_id:slackAcc.credentials.team_id, token:slackAcc.credentials.access_token};
}

async function findSlackTokenForChannel(channelId) {
  const mapping=await ChannelMapping.findOne({platform:'slack',roomId:channelId}).lean();
  if(!mapping) {
    console.warn(`No channel mapping for Slack channel ${channelId}, creating default`);
    // create a mapping for first slack account found:
    const slackAcc=await Account.findOne({platform:'slack'}).lean();
    if(!slackAcc) {
      console.error('No slack account found, cannot map user');
      return null;
    }
    await ChannelMapping.create({platform:'slack',roomId:channelId, team_id:slackAcc.credentials.team_id, userId:slackAcc.userId});
    return {team_id:slackAcc.credentials.team_id, token:slackAcc.credentials.access_token};
  }

  const acc=await Account.findOne({platform:'slack', userId:mapping.userId}).lean();
  if(!acc||!acc.credentials.access_token) {
    console.error('Slack account not found for mapped user');
    return null;
  }
  return {team_id:acc.credentials.team_id, token:acc.credentials.access_token};
}

export async function sendSlackMessage(channelId, content) {
  const mapping=await findSlackTokenForChannel(channelId);
  if(!mapping) {
    console.error(`No Slack token found for channel ${channelId}`);
    return;
  }
  const { token }=mapping;
  const client=new WebClient(token);
  try {
    await client.chat.postMessage({channel:channelId,text:content});
    console.log(`Auto-responded on Slack to ${channelId}: ${content}`);
  } catch(err) {
    console.error('Slack send message error:', err);
  }
}

async function fetchSlackUserName(team_id,user_id) {
  const key=`${team_id}:${user_id}`;
  if(slackUserCache.has(key)) return slackUserCache.get(key);

  // find token from any account with this team_id:
  const acc=await Account.findOne({'credentials.team_id':team_id,platform:'slack'}).lean();
  if(!acc||!acc.credentials.access_token) return user_id;
  const token=acc.credentials.access_token;

  const client=new WebClient(token);
  try {
    const res=await client.users.info({user:user_id});
    if(res.ok && res.user && res.user.real_name) {
      slackUserCache.set(key,res.user.real_name);
      return res.user.real_name;
    }
    return user_id;
  } catch(err) {
    console.error('Slack fetch user name error:',err);
    return user_id;
  }
}

async function getUserIdForPlatformRoom(platform, roomId) {
  const mapping=await ChannelMapping.findOne({platform, roomId}).lean();
  if(mapping) return mapping.userId;

  // If no mapping, pick first slack account:
  const slackAcc=await Account.findOne({platform:'slack'}).lean();
  if(!slackAcc) {
    console.warn('No slack account found to map user');
    return null;
  }
  await ChannelMapping.create({platform:'slack',roomId,team_id:slackAcc.credentials.team_id,userId:slackAcc.userId});
  return slackAcc.userId;
}

export async function processSlackEvent(team_id, event) {
  if (event.type==='message' && event.channel && event.user && event.text) {
    const userName=await fetchSlackUserName(team_id,event.user);
    const timestamp=new Date(); 
    let msg={
      content:event.text,
      sender:event.user,
      senderName:userName,
      timestamp,
      priority:'medium',
      platform:'slack',
      roomId:event.channel
    };

    const userId=await getUserIdForPlatformRoom('slack', event.channel);
    if(userId) {
      msg=await applyRulesToMessage(msg,userId);
    }
    const saved=await Message.create(msg);
    ioEmitter.emit('new_message', saved.toObject());
  }
}

export async function exchangeSlackCodeForToken(code) {
  const client=new WebClient();
  const resp=await client.oauth.v2.access({
    client_id:process.env.SLACK_CLIENT_ID,
    client_secret:process.env.SLACK_CLIENT_SECRET,
    code,
    redirect_uri:process.env.REDIRECT_URI
  });
  return resp;
}

async function findSlackAccountForChannel(channelId) {
  const mapping = await import('../models/ChannelMapping.js').then(m=>m.default.findOne({platform:'slack', roomId:channelId}).lean());
  if(!mapping) {
    console.warn(`No Slack mapping for channel ${channelId}, attempting to create one.`);
    const anyAcc=await Account.findOne({platform:'slack'}).lean();
    if(!anyAcc) {
      console.error('No slack account found for mapping');
      return null;
    }
    await import('../models/ChannelMapping.js').then(m=>m.default.create({platform:'slack', roomId:channelId, team_id:anyAcc.credentials.team_id, userId:anyAcc.userId}));
    return anyAcc;
  }
  const acc=await Account.findOne({platform:'slack', userId:mapping.userId}).lean();
  return acc;
}

