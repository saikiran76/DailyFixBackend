// backend/services/contactService.js
// Purpose: Fetch all contacts from connected platforms and return a {id: name} mapping

import { getAllWhatsAppContacts } from './whatsappService.js';
// If Slack/Telegram can't provide names, we fallback to generic names.

export async function fetchAllContacts(userId) {
  const contacts = {};

  // WhatsApp contacts
  const waContacts = await getAllWhatsAppContacts(); 
  // returns { "jid@s.whatsapp.net": "Display Name", ... }
  Object.assign(contacts, waContacts);

  // Telegram - no direct source given, fallback to generic
  // If we have Telegram accounts, we can give a generic name
  // In a real scenario, we'd implement getAllTelegramContacts.
  // For now, assume each Telegram roomId starts with "telegram_" and fallback:
  // If no info, we do nothing special. If no info given for Telegram, skip.

  // Slack - similarly, fallback to generic "Slack Contact"
  // If Slack roomIds known pattern "slack_...", fallback if no name found on Slack.

  // If we wanted to integrate Slack/Telegram name fetching, we would do:
  // const tgContacts = await getAllTelegramContacts(userId);
  // const slackContacts = await getAllSlackContacts(userId);
  // Object.assign(contacts, tgContacts, slackContacts);

  return contacts;
}

// Example fallback logic will be in frontend deriveRoomsFromMessages.
