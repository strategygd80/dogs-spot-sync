// ============================================================
// The Dogs Spot — One-Time Backfill Script
// Pulls existing GHL boarding appointments into Supabase
// so the portal isn't empty while waiting on live webhooks.
//
// Safe to re-run — upserts by GHL appointment ID, no duplicates.
//
// Setup:
//   npm install
//   node backfill.js
// ============================================================

require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// ------------------------------------------------------------
// CONFIG — same values as server.js, pulled from .env
// ------------------------------------------------------------
const CONFIG = {
  GHL_TOKEN:    process.env.GHL_TOKEN,
  GHL_LOCATION: process.env.GHL_LOCATION,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,

  CALENDARS: {
    DROPOFF_INPERSON: 'wS5N8WN4BbzznaLjEg1N',   // Boarding Drop Off
    DROPOFF_ONLINE:   'ZmmjQJszkRMUltfEbumB',   // Boarding Drop Off - Online
    PICKUP_INPERSON:  '1FnbK7pQp1ViZWIzX95R',   // Boarding Pick Up
    PICKUP_ONLINE:    'bN6wWGJa0qKq0QGRg4CC',   // Boarding Pick Up - Online
  },

  // How far back/forward to pull appointments
  LOOKBACK_DAYS:  90,
  LOOKAHEAD_DAYS: 180,

  // Max hours apart for a Drop Off + Pick Up to be considered the same stay
  PAIRING_WINDOW_HOURS: 24 * 14, // 14 days — boarding stays can run long
};

const DROPOFF_CALENDAR_IDS = new Set([
  CONFIG.CALENDARS.DROPOFF_INPERSON,
  CONFIG.CALENDARS.DROPOFF_ONLINE,
]);
const PICKUP_CALENDAR_IDS = new Set([
  CONFIG.CALENDARS.PICKUP_INPERSON,
  CONFIG.CALENDARS.PICKUP_ONLINE,
]);

if (!CONFIG.GHL_TOKEN || !CONFIG.GHL_LOCATION || !CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_KEY) {
  console.error('Missing required env vars. Check your .env file has GHL_TOKEN, GHL_LOCATION, SUPABASE_URL, SUPABASE_KEY.');
  process.exit(1);
}

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

const ghl = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: {
    Authorization: `Bearer ${CONFIG.GHL_TOKEN}`,
    Version: '2021-04-15',
    'Content-Type': 'application/json',
  },
});

// ------------------------------------------------------------
// FETCH ALL APPOINTMENTS FOR A CALENDAR IN A DATE WINDOW
// GHL paginates calendar events — loop until exhausted
// ------------------------------------------------------------
async function fetchCalendarEvents(calendarId, startMs, endMs) {
  const events = [];
  let url = '/calendars/events';
  let params = {
    locationId: CONFIG.GHL_LOCATION,
    calendarId,
    startTime: startMs,
    endTime: endMs,
  };

  try {
    const res = await ghl.get(url, { params });
    const batch = res.data?.events || res.data?.appointments || [];
    events.push(...batch);
  } catch (err) {
    console.error(`Failed to fetch events for calendar ${calendarId}:`, err.response?.data || err.message);
  }

  return events;
}

// ------------------------------------------------------------
// GET CONTACT DETAILS (name/email/phone)
// ------------------------------------------------------------
// ------------------------------------------------------------
// CUSTOM FIELD LOOKUP — "Dog's Name" is stored as a contact
// custom field in GHL, not in the appointment title.
// ------------------------------------------------------------
let dogNameFieldId = null;
async function resolveDogNameFieldId() {
  if (dogNameFieldId) return dogNameFieldId;
  try {
    const res = await ghl.get('/locations/' + CONFIG.GHL_LOCATION + '/customFields');
    const fields = res.data?.customFields || [];
    const match = fields.find(f =>
      (f.name || '').toLowerCase().includes("dog") &&
      (f.name || '').toLowerCase().includes("name")
    );
    if (match) {
      dogNameFieldId = match.id;
      console.log(`Found "Dog's Name" custom field: ${match.name} (${match.id})`);
    } else {
      console.warn('Could not find a custom field matching "Dog\'s Name" — dog names will be blank. Check field name in GHL.');
    }
  } catch (err) {
    console.error('Failed to fetch custom field definitions:', err.response?.data || err.message);
  }
  return dogNameFieldId;
}

function extractDogName(contact, fieldId) {
  if (!contact || !fieldId || !Array.isArray(contact.customFields)) return null;
  const field = contact.customFields.find(f => f.id === fieldId);
  return field?.value || field?.fieldValue || null;
}

const contactCache = new Map();
async function getContact(contactId) {
  if (!contactId) return null;
  if (contactCache.has(contactId)) return contactCache.get(contactId);
  try {
    const res = await ghl.get(`/contacts/${contactId}`);
    const raw = res.data?.contact || null;
    if (!raw) { contactCache.set(contactId, null); return null; }

    // GHL doesn't reliably return a flat "name" field — build one from parts
    const fullName =
      raw.name ||
      raw.contactName ||
      [raw.firstName, raw.lastName].filter(Boolean).join(' ').trim() ||
      raw.email ||
      null;

    const contact = { ...raw, name: fullName };
    contactCache.set(contactId, contact);
    return contact;
  } catch (err) {
    console.error(`Failed to fetch contact ${contactId}:`, err.response?.data || err.message);
    return null;
  }
}

// ------------------------------------------------------------
// MAIN BACKFILL
// ------------------------------------------------------------
async function run() {
  await resolveDogNameFieldId();

  const now = Date.now();
  const startMs = now - CONFIG.LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const endMs   = now + CONFIG.LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000;

  console.log(`Pulling appointments from ${new Date(startMs).toISOString()} to ${new Date(endMs).toISOString()}`);

  // 1. Pull every appointment from all four boarding calendars
  let allEvents = [];
  for (const [label, calendarId] of Object.entries(CONFIG.CALENDARS)) {
    console.log(`Fetching calendar: ${label} (${calendarId})...`);
    const events = await fetchCalendarEvents(calendarId, startMs, endMs);
    console.log(`  → ${events.length} appointments found`);
    allEvents.push(...events.map(e => ({ ...e, _calendarId: calendarId })));
  }

  if (allEvents.length === 0) {
    console.log('No appointments found in the given window. Nothing to backfill.');
    return;
  }

  // 2. Group by contact, separating dropoff/pickup
  const byContact = new Map();
  for (const ev of allEvents) {
    const contactId = ev.contactId;
    if (!contactId) continue;
    if (!byContact.has(contactId)) byContact.set(contactId, { dropoffs: [], pickups: [] });
    const bucket = byContact.get(contactId);
    if (DROPOFF_CALENDAR_IDS.has(ev._calendarId)) bucket.dropoffs.push(ev);
    else if (PICKUP_CALENDAR_IDS.has(ev._calendarId)) bucket.pickups.push(ev);
  }

  console.log(`\nGrouped appointments for ${byContact.size} contacts. Pairing...\n`);

  let created = 0, paired = 0, incomplete = 0, skipped = 0, failed = 0;

  // 3. For each contact, pair drop-offs with the nearest unmatched pick-up
  for (const [contactId, { dropoffs, pickups }] of byContact) {
    const usedPickups = new Set();
    const contact = await getContact(contactId);

    for (const dropoff of dropoffs) {
      const dropoffTime = new Date(dropoff.startTime).getTime();

      // Find nearest pickup after this dropoff, within the pairing window, not already used
      let bestPickup = null;
      let bestDiff = Infinity;
      for (const pickup of pickups) {
        if (usedPickups.has(pickup.id)) continue;
        const pickupTime = new Date(pickup.startTime).getTime();
        const diff = pickupTime - dropoffTime;
        if (diff < 0) continue; // pickup must come after dropoff
        if (diff > CONFIG.PAIRING_WINDOW_HOURS * 60 * 60 * 1000) continue;
        if (diff < bestDiff) { bestDiff = diff; bestPickup = pickup; }
      }
      if (bestPickup) usedPickups.add(bestPickup.id);

      const source = (dropoff._calendarId === CONFIG.CALENDARS.DROPOFF_ONLINE) ? 'online' : 'internal';
      const status = bestPickup ? 'completed_or_active' : 'incomplete'; // resolved below

      try {
        const result = await upsertStay({
          contactId,
          contact,
          dropoff,
          pickup: bestPickup,
          source,
        });
        if (result === 'incomplete') incomplete++;
        else if (bestPickup) paired++;
        else created++;
      } catch (err) {
        console.error(`Failed to upsert stay for contact ${contactId}:`, err.message);
        failed++;
      }
    }

    // Any leftover pickups with no matching dropoff become incomplete records too
    for (const pickup of pickups) {
      if (usedPickups.has(pickup.id)) continue;
      const source = (pickup._calendarId === CONFIG.CALENDARS.PICKUP_ONLINE) ? 'online' : 'internal';
      try {
        await upsertStay({ contactId, contact, dropoff: null, pickup, source });
        incomplete++;
      } catch (err) {
        console.error(`Failed to upsert orphan pickup for contact ${contactId}:`, err.message);
        failed++;
      }
    }
  }

  console.log(`\nBackfill complete.`);
  console.log(`  Paired (dropoff+pickup): ${paired}`);
  console.log(`  Incomplete (missing half): ${incomplete}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Failed: ${failed}`);
}

// ------------------------------------------------------------
// UPSERT A STAY INTO boarding_stays
// Determines real status from today's date once both ends known
// ------------------------------------------------------------
async function upsertStay({ contactId, contact, dropoff, pickup, source }) {
  const today = new Date();
  const startDate = dropoff ? dropoff.startTime : null;
  const endDate   = pickup  ? pickup.startTime  : null;

  let status = 'incomplete';
  if (startDate && endDate) {
    const start = new Date(startDate);
    const end   = new Date(endDate);
    if (end < today) status = 'completed';
    else if (start <= today && end >= today) status = 'active';
    else status = 'confirmed';
  }

  const payload = {
    contact_id:   contactId,
    owner_name:   contact?.name  || null,
    owner_email:  contact?.email || null,
    owner_phone:  contact?.phone || null,
    dog_name:     extractDogName(contact, dogNameFieldId),
    source,
    status,
    start_date: startDate,
    end_date:   endDate,
    ghl_dropoff_appointment_id: dropoff?.id || null,
    ghl_pickup_appointment_id:  pickup?.id  || null,
    dropoff_calendar_id: dropoff?._calendarId || null,
    pickup_calendar_id:  pickup?._calendarId  || null,
    last_modified_source: 'ghl',
    last_synced_at: new Date().toISOString(),
    is_returning_client: false, // self-corrects as live bookings come through
  };

  // Check if a stay already exists for either appointment ID — upsert, don't duplicate
  const orFilters = [];
  if (dropoff?.id) orFilters.push(`ghl_dropoff_appointment_id.eq.${dropoff.id}`);
  if (pickup?.id)  orFilters.push(`ghl_pickup_appointment_id.eq.${pickup.id}`);

  let existing = null;
  if (orFilters.length > 0) {
    const { data } = await supabase
      .from('boarding_stays')
      .select('id')
      .or(orFilters.join(','))
      .limit(1);
    existing = data && data.length > 0 ? data[0] : null;
  }

  if (existing) {
    const { error } = await supabase.from('boarding_stays').update(payload).eq('id', existing.id);
    if (error) throw error;
    console.log(`  Updated stay ${existing.id} — ${payload.owner_name || 'Unknown'} (${status})`);
  } else {
    const { data, error } = await supabase.from('boarding_stays').insert(payload).select().single();
    if (error) throw error;
    console.log(`  Created stay ${data.id} — ${payload.owner_name || 'Unknown'} (${status})`);
  }

  return status;
}

run().then(() => {
  console.log('\nDone.');
  process.exit(0);
}).catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
