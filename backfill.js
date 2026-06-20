// ============================================================
// The Dogs Spot — Backfill Existing Appointments
// One-time script: pulls all existing appointments from the
// four boarding calendars and pairs them into boarding_stays
// ============================================================
// Setup:
//   npm install @supabase/supabase-js axios dotenv
//   node backfill.js
//
// Run this ONCE after deploying server.js and before (or after)
// setting up the live workflow webhooks. Safe to re-run — it
// upserts by GHL appointment ID, so it won't create duplicates.
// ============================================================

require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const CONFIG = {
  GHL_TOKEN:    process.env.GHL_TOKEN,
  GHL_LOCATION: process.env.GHL_LOCATION,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,

  CALENDARS: {
    DROPOFF_INPERSON: 'wS5N8WN4BbzznaLjEg1N',   // Boarding Drop Off
    DROPOFF_ONLINE:   'ZmmjQJszkRMUltfEbumB',    // Boarding Drop Off - Online
    PICKUP_INPERSON:  '1FnbK7pQp1ViZWIzX95R',   // Boarding Pick Up
    PICKUP_ONLINE:    'bN6wWGJa0qKq0QGRg4CC',    // Boarding Pick Up - Online
  },

  // How far back/forward to pull appointments (adjust as needed)
  LOOKBACK_DAYS:  90,   // pull past appointments up to 90 days ago
  LOOKAHEAD_DAYS: 180,  // pull future appointments up to 180 days ahead

  // Window in hours within which two appointments are considered the same booking
  PAIRING_WINDOW_HOURS: 4, // wider than live sync since backfill timestamps are less precise
};

const DROPOFF_CALENDAR_IDS = new Set([CONFIG.CALENDARS.DROPOFF_INPERSON, CONFIG.CALENDARS.DROPOFF_ONLINE]);
const PICKUP_CALENDAR_IDS  = new Set([CONFIG.CALENDARS.PICKUP_INPERSON,  CONFIG.CALENDARS.PICKUP_ONLINE]);
const ALL_CALENDAR_IDS = [
  CONFIG.CALENDARS.DROPOFF_INPERSON,
  CONFIG.CALENDARS.DROPOFF_ONLINE,
  CONFIG.CALENDARS.PICKUP_INPERSON,
  CONFIG.CALENDARS.PICKUP_ONLINE,
];

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
// FETCH ALL APPOINTMENTS FOR A CALENDAR
// ------------------------------------------------------------
async function fetchAppointmentsForCalendar(calendarId) {
  const startTime = Date.now() - CONFIG.LOOKBACK_DAYS  * 86400000;
  const endTime   = Date.now() + CONFIG.LOOKAHEAD_DAYS * 86400000;

  try {
    const res = await ghl.get('/calendars/events', {
      params: {
        locationId: CONFIG.GHL_LOCATION,
        calendarId,
        startTime,
        endTime,
      },
    });
    return res.data?.events || res.data?.appointments || [];
  } catch (err) {
    console.error(`Failed to fetch appointments for calendar ${calendarId}:`, err.response?.data || err.message);
    return [];
  }
}

// ------------------------------------------------------------
// FETCH CONTACT DETAILS
// ------------------------------------------------------------
const contactCache = new Map();
async function getContact(contactId) {
  if (contactCache.has(contactId)) return contactCache.get(contactId);
  try {
    const res = await ghl.get(`/contacts/${contactId}`);
    const contact = res.data?.contact || null;
    contactCache.set(contactId, contact);
    return contact;
  } catch (err) {
    console.error(`Failed to fetch contact ${contactId}:`, err.response?.data || err.message);
    return null;
  }
}

// ------------------------------------------------------------
// MAIN BACKFILL LOGIC
// ------------------------------------------------------------
async function backfill() {
  console.log('Starting backfill...\n');

  // Step 1: pull all appointments from all four calendars
  let allAppointments = [];
  for (const calendarId of ALL_CALENDAR_IDS) {
    console.log(`Fetching appointments for calendar ${calendarId}...`);
    const appts = await fetchAppointmentsForCalendar(calendarId);
    console.log(`  -> found ${appts.length} appointments`);
    allAppointments.push(...appts.map(a => ({ ...a, calendarId: a.calendarId || calendarId })));
  }

  console.log(`\nTotal appointments fetched: ${allAppointments.length}\n`);

  if (allAppointments.length === 0) {
    console.log('No appointments found. Check calendar IDs and date range.');
    return;
  }

  // Step 2: sort by start time so pairing is deterministic
  allAppointments.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  // Step 3: group into stays by contactId + proximity
  const stays = []; // { dropoff, pickup, contactId }

  for (const appt of allAppointments) {
    const isDropoff = DROPOFF_CALENDAR_IDS.has(appt.calendarId);
    const isPickup  = PICKUP_CALENDAR_IDS.has(appt.calendarId);
    if (!isDropoff && !isPickup) continue;

    const contactId = appt.contactId;
    const apptTime  = new Date(appt.startTime).getTime();
    const windowMs  = CONFIG.PAIRING_WINDOW_HOURS * 3600 * 1000;

    // Try to find an existing incomplete stay for this contact within the window
    let matched = null;
    for (const stay of stays) {
      if (stay.contactId !== contactId) continue;
      const refTime = stay.dropoff
        ? new Date(stay.dropoff.startTime).getTime()
        : new Date(stay.pickup.startTime).getTime();

      if (Math.abs(apptTime - refTime) <= windowMs * 20) { // wider tolerance: stays can span days
        if (isDropoff && !stay.dropoff) { matched = stay; break; }
        if (isPickup  && !stay.pickup)  { matched = stay; break; }
      }
    }

    if (matched) {
      if (isDropoff) matched.dropoff = appt;
      if (isPickup)  matched.pickup  = appt;
    } else {
      stays.push({
        contactId,
        dropoff: isDropoff ? appt : null,
        pickup:  isPickup  ? appt : null,
      });
    }
  }

  console.log(`Grouped into ${stays.length} stay(s)\n`);

  // Step 4: insert/upsert into Supabase
  let created = 0, updated = 0, incomplete = 0, errors = 0;

  for (const stay of stays) {
    const { dropoff, pickup, contactId } = stay;
    const contact = await getContact(contactId);

    const source = (dropoff?.calendarId === CONFIG.CALENDARS.DROPOFF_ONLINE || pickup?.calendarId === CONFIG.CALENDARS.PICKUP_ONLINE)
      ? 'online'
      : 'internal';

    // Determine status — for backfill, assume confirmed unless we can detect otherwise
    let status = 'confirmed';
    if (!dropoff || !pickup) status = 'incomplete';
    if (dropoff?.appointmentStatus === 'cancelled' || pickup?.appointmentStatus === 'cancelled') status = 'cancelled';

    const now = new Date();
    const startDate = dropoff?.startTime ? new Date(dropoff.startTime) : null;
    const endDate   = pickup?.startTime  ? new Date(pickup.startTime)  : null;
    if (status === 'confirmed' && startDate && endDate) {
      if (now >= startDate && now <= endDate) status = 'active';
      else if (now > endDate) status = 'completed';
    }

    const payload = {
      ghl_dropoff_appointment_id: dropoff?.id || null,
      ghl_pickup_appointment_id:  pickup?.id  || null,
      dropoff_calendar_id: dropoff?.calendarId || null,
      pickup_calendar_id:  pickup?.calendarId  || null,
      contact_id:   contactId,
      owner_name:   contact?.name  || contact?.firstName || null,
      owner_email:  contact?.email || null,
      owner_phone:  contact?.phone || null,
      dog_name:     null, // not reliably available from appointment data — can be backfilled later from custom fields
      start_date:   dropoff?.startTime || null,
      end_date:     pickup?.startTime  || null,
      source,
      status,
      is_returning_client: false, // can't reliably determine in backfill; will self-correct on next booking
      last_modified_source: 'ghl',
      last_synced_at: new Date().toISOString(),
    };

    try {
      // Check if this stay already exists (by either appointment ID)
      let existing = null;
      if (payload.ghl_dropoff_appointment_id) {
        const { data } = await supabase.from('boarding_stays').select('id').eq('ghl_dropoff_appointment_id', payload.ghl_dropoff_appointment_id).limit(1);
        if (data && data.length) existing = data[0];
      }
      if (!existing && payload.ghl_pickup_appointment_id) {
        const { data } = await supabase.from('boarding_stays').select('id').eq('ghl_pickup_appointment_id', payload.ghl_pickup_appointment_id).limit(1);
        if (data && data.length) existing = data[0];
      }

      if (existing) {
        await supabase.from('boarding_stays').update(payload).eq('id', existing.id);
        updated++;
      } else {
        await supabase.from('boarding_stays').insert(payload);
        created++;
      }

      if (status === 'incomplete') incomplete++;

      console.log(`  ✓ ${contact?.name || contactId} — ${payload.start_date ? new Date(payload.start_date).toDateString() : '?'} -> ${payload.end_date ? new Date(payload.end_date).toDateString() : '?'} [${status}]`);
    } catch (err) {
      errors++;
      console.error(`  ✗ Failed for contact ${contactId}:`, err.message);
    }
  }

  console.log(`\n========================================`);
  console.log(`Backfill complete.`);
  console.log(`  Created:    ${created}`);
  console.log(`  Updated:    ${updated}`);
  console.log(`  Incomplete: ${incomplete} (missing drop off or pick up)`);
  console.log(`  Errors:     ${errors}`);
  console.log(`========================================`);
}

backfill().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
