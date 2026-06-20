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

// --dry-run: pair appointments and print what WOULD be written, but never
// touch Supabase. Run this first after any pairing-logic change.
const DRY_RUN = process.argv.includes('--dry-run');

const CONFIG = {
  GHL_TOKEN:    process.env.GHL_TOKEN,
  GHL_LOCATION: process.env.GHL_LOCATION,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,

  // Calendar IDs — same mapping as server.js, kept in sync
  CALENDARS: {
    boarding: {
      DROPOFF_INPERSON: 'wS5N8WN4BbzznaLjEg1N',   // Boarding Drop Off
      DROPOFF_ONLINE:   'ZmmjQJszkRMUltfEbumB',    // Boarding Drop Off - Online
      PICKUP_INPERSON:  '1FnbK7pQp1ViZWIzX95R',   // Boarding Pick Up
      PICKUP_ONLINE:    'bN6wWGJa0qKq0QGRg4CC',    // Boarding Pick Up - Online
    },
    basic: {
      DROPOFF_INPERSON: '34JtodEqRp3K2wLp0a0y',   // Basic Drop Off
      PICKUP_INPERSON:  'U53Ci7ndlS0NIkAa6vya',   // Basic Pick-up
      DROPOFF_ONLINE:   null,
      PICKUP_ONLINE:    null,
    },
    leash_free: {
      DROPOFF_INPERSON: 'MXqoZqw2t3ewo1Oxja2m',   // Leash Free Drop Off
      PICKUP_INPERSON:  'QBN6Y6UGIgDufXHz6B2I',    // Leash Free Pick Up
      DROPOFF_ONLINE:   null,
      PICKUP_ONLINE:    null,
    },
    service_dog: {
      DROPOFF_INPERSON: 'U0sp9FfaU9qOiWp1Upb',     // Service Dog Drop Off
      PICKUP_INPERSON:  '8rQdqxN39H6Db3Duf5ZX',    // Service Dog Pick-up
      DROPOFF_ONLINE:   null,
      PICKUP_ONLINE:    null,
    },
    community: {
      DROPOFF_INPERSON: 'WMnuQPTsY8tz3JaxqPPf',    // Community Drop Off
      PICKUP_INPERSON:  'DN6b9L0gVEwBI80v7Ctk',    // Community Pick-up
      DROPOFF_ONLINE:   null,
      PICKUP_ONLINE:    null,
    },
    bundle: {
      DROPOFF_INPERSON: 'ZqzoS3ckFZafZcaUKyOM',    // Bundle Drop Off — confirm this ID
      PICKUP_INPERSON:  '2sAl9Q61WM2WNTqLqcGj',    // Bundle Pick-up
      DROPOFF_ONLINE:   null,
      PICKUP_ONLINE:    null,
    },
  },

  // How far back/forward to pull appointments (adjust as needed)
  LOOKBACK_DAYS:  90,   // pull past appointments up to 90 days ago
  LOOKAHEAD_DAYS: 180,  // pull future appointments up to 180 days ahead

  // NOTE: pairing is no longer a symmetric +/- hour window (see MAX_STAY_DAYS
  // near the pairing logic below). A pickup can now only pair with a dropoff
  // at or before it, and ties are broken by closest time gap.

  // Business timezone — used to correctly determine "today" for status calculation
  TIMEZONE: 'America/New_York',
};

// Build lookup map: calendarId -> { serviceType, role, source }
const CALENDAR_LOOKUP = {};
for (const [serviceType, cals] of Object.entries(CONFIG.CALENDARS)) {
  if (cals.DROPOFF_INPERSON) CALENDAR_LOOKUP[cals.DROPOFF_INPERSON] = { serviceType, role: 'dropoff', source: 'internal' };
  if (cals.DROPOFF_ONLINE)   CALENDAR_LOOKUP[cals.DROPOFF_ONLINE]   = { serviceType, role: 'dropoff', source: 'online' };
  if (cals.PICKUP_INPERSON)  CALENDAR_LOOKUP[cals.PICKUP_INPERSON]  = { serviceType, role: 'pickup',  source: 'internal' };
  if (cals.PICKUP_ONLINE)    CALENDAR_LOOKUP[cals.PICKUP_ONLINE]    = { serviceType, role: 'pickup',  source: 'online' };
}

const ALL_CALENDAR_IDS = Object.keys(CALENDAR_LOOKUP);

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

// ------------------------------------------------------------
// TIMEZONE HELPER
// Returns YYYY-MM-DD for a given date, evaluated in a specific
// timezone — NOT the server's local time or raw UTC. This is
// what fixes "today" being calculated one day off.
// ------------------------------------------------------------
function getDateStringInTZ(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date); // en-CA locale formats as YYYY-MM-DD
}


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
  console.log(DRY_RUN ? 'Starting backfill (DRY RUN — no writes to Supabase)...\n' : 'Starting backfill...\n');

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

  // Step 3: group into stays by contactId + service_type + proximity
  //
  // Pairing rules (fixed):
  //   1. A pickup may only pair with a dropoff that happened at or before it.
  //      This stops a pickup from accidentally pairing with a *later*
  //      dropoff and producing end_date < start_date rows.
  //   2. Among all open, eligible stays for a contact+serviceType, pick the
  //      CLOSEST one in time, not the first one encountered in array order.
  //      This matters for repeat/back-to-back boarders.
  //   3. Max span between dropoff and pickup is capped (see MAX_STAY_DAYS)
  //      so we don't pair a dropoff with some unrelated pickup weeks later
  //      just because the contact had no other open stay.
  const MAX_STAY_DAYS = 30; // generous ceiling for a single boarding stay
  const maxSpanMs = MAX_STAY_DAYS * 86400000;

  const stays = []; // { dropoff, pickup, contactId, serviceType }

  for (const appt of allAppointments) {
    const calMeta = CALENDAR_LOOKUP[appt.calendarId];
    if (!calMeta) continue; // not one of our tracked calendars

    const { serviceType, role } = calMeta;
    const isDropoff = role === 'dropoff';
    const isPickup  = role === 'pickup';

    const contactId = appt.contactId;
    const apptTime  = new Date(appt.startTime).getTime();

    // Collect every open, eligible stay for this contact + service type,
    // then choose the closest in time rather than the first match found.
    let best = null;
    let bestDelta = Infinity;

    for (const stay of stays) {
      if (stay.contactId !== contactId) continue;
      if (stay.serviceType !== serviceType) continue; // never cross-pair different services

      if (isDropoff && !stay.dropoff && stay.pickup) {
        // Filling in a missing dropoff for a stay that already has a pickup.
        // The dropoff must be at or before that pickup.
        const pickupTime = new Date(stay.pickup.startTime).getTime();
        const delta = pickupTime - apptTime;
        if (delta >= 0 && delta <= maxSpanMs && delta < bestDelta) {
          best = stay; bestDelta = delta;
        }
      } else if (isPickup && !stay.pickup && stay.dropoff) {
        // Filling in a missing pickup for a stay that already has a dropoff.
        // The pickup must be at or after that dropoff.
        const dropoffTime = new Date(stay.dropoff.startTime).getTime();
        const delta = apptTime - dropoffTime;
        if (delta >= 0 && delta <= maxSpanMs && delta < bestDelta) {
          best = stay; bestDelta = delta;
        }
      } else if (isDropoff && !stay.dropoff && !stay.pickup) {
        // Shouldn't normally happen (empty stay shouldn't exist), but guard anyway.
        best = best || stay;
      } else if (isPickup && !stay.pickup && !stay.dropoff) {
        best = best || stay;
      }
    }

    if (best) {
      if (isDropoff) best.dropoff = appt;
      if (isPickup)  best.pickup  = appt;
    } else {
      stays.push({
        contactId,
        serviceType,
        dropoff: isDropoff ? appt : null,
        pickup:  isPickup  ? appt : null,
      });
    }
  }

  console.log(`Grouped into ${stays.length} stay(s)\n`);

  // Step 4: insert/upsert into Supabase
  let created = 0, updated = 0, incomplete = 0, errors = 0;

  for (const stay of stays) {
    const { dropoff, pickup, contactId, serviceType } = stay;
    const contact = await getContact(contactId);

    const dropoffMeta = dropoff ? CALENDAR_LOOKUP[dropoff.calendarId] : null;
    const pickupMeta  = pickup  ? CALENDAR_LOOKUP[pickup.calendarId]  : null;
    const source = (dropoffMeta?.source === 'online' || pickupMeta?.source === 'online') ? 'online' : 'internal';

    // Determine status — for backfill, assume confirmed unless we can detect otherwise
    let status = 'confirmed';
    if (!dropoff || !pickup) status = 'incomplete';
    if (dropoff?.appointmentStatus === 'cancelled' || pickup?.appointmentStatus === 'cancelled') status = 'cancelled';

    // Timezone-aware "today" comparison — compares calendar dates in the
    // business timezone, not raw UTC instants, so a stay starting today
    // doesn't get misclassified due to UTC offset.
    const todayStr = getDateStringInTZ(new Date(), CONFIG.TIMEZONE);
    const startDate = dropoff?.startTime ? new Date(dropoff.startTime) : null;
    const endDate   = pickup?.startTime  ? new Date(pickup.startTime)  : null;
    const startStr  = startDate ? getDateStringInTZ(startDate, CONFIG.TIMEZONE) : null;
    const endStr    = endDate   ? getDateStringInTZ(endDate, CONFIG.TIMEZONE)   : null;

    if (status === 'confirmed' && startStr && endStr) {
      if (startStr <= todayStr && endStr >= todayStr) status = 'active';
      else if (endStr < todayStr) status = 'completed';
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
      service_type: serviceType,
      status,
      is_returning_client: false, // can't reliably determine in backfill; will self-correct on next booking
      last_modified_source: 'ghl',
      last_synced_at: new Date().toISOString(),
    };

    try {
      if (DRY_RUN) {
        console.log(`  [dry-run] would upsert ${contact?.name || contactId} — ${payload.start_date ? new Date(payload.start_date).toDateString() : '?'} -> ${payload.end_date ? new Date(payload.end_date).toDateString() : '?'} [${status}] (dropoff:${payload.ghl_dropoff_appointment_id || 'none'} pickup:${payload.ghl_pickup_appointment_id || 'none'})`);
        if (status === 'incomplete') incomplete++;
        continue;
      }

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
  console.log(DRY_RUN ? `Dry run complete. No data was written.` : `Backfill complete.`);
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
