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

  // Calendar IDs — Mirroring server.js perfectly
  CALENDARS: {
    boarding: {
      DROPOFF_INPERSON: 'wS5N8WN4BbzznaLjEg1N',   // Boarding Drop Off
      DROPOFF_ONLINE:   'ZmmjQJszkRMUltfEbumB',    // Boarding Drop Off - Online
      PICKUP_INPERSON:  '1FnbK7pQp1ViZWIzX9SR',   // Boarding Pick Up
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
      DROPOFF_INPERSON: 'ZqzoS3ckFZafZcaUKyOM',    // Bundle Drop Off
      PICKUP_INPERSON:  '2sAl9Q61WM2WNTqLqcGj',    // Bundle Pick-up
      DROPOFF_ONLINE:   null,
      PICKUP_ONLINE:    null,
    },
  },

  LOOKBACK_DAYS:  365,  // Expanded to 1 full year to capture deeper historical pairings
  LOOKAHEAD_DAYS: 180,  
  TIMEZONE: 'America/New_York',
  KENNEL_SIZE_FIELD_IDS: ['REPLACE_WITH_KENNEL_SIZE_FIELD_ID'], // Must match server.js configuration
};

// Build lookup maps
const CALENDAR_LOOKUP = {};
for (const [serviceType, cals] of Object.entries(CONFIG.CALENDARS)) {
  if (cals.DROPOFF_INPERSON) CALENDAR_LOOKUP[cals.DROPOFF_INPERSON] = { serviceType, role: 'dropoff', source: 'internal' };
  if (cals.DROPOFF_ONLINE)   CALENDAR_LOOKUP[cals.DROPOFF_ONLINE]   = { serviceType, role: 'dropoff', source: 'online' };
  if (cals.PICKUP_INPERSON)  CALENDAR_LOOKUP[cals.PICKUP_INPERSON]  = { serviceType, role: 'pickup',  source: 'internal' };
  if (cals.PICKUP_ONLINE)    CALENDAR_LOOKUP[cals.PICKUP_ONLINE]    = { serviceType, role: 'pickup',  source: 'online' };
}
const ALL_CALENDAR_IDS = Object.keys(CALENDAR_LOOKUP);

const PAIRING_GROUPS = {
  boarding:    'boarding',
  basic:       'flexible',
  bundle:      'flexible',
  leash_free:  'flexible',
  service_dog: 'flexible',
  community:   'flexible',
};
function pairingGroupOf(serviceType) {
  return PAIRING_GROUPS[serviceType] || serviceType;
}

const KENNEL_CATEGORY_MAP = {
  'special need - graduated':    { kennel_type: 'special_needs', kennel_grad_status: 'graduated'    },
  'special need - non graduate': { kennel_type: 'special_needs', kennel_grad_status: 'non_graduate' },
  'special need - in process':   { kennel_type: 'special_needs', kennel_grad_status: 'in_process'   },
  'special needs - graduated':   { kennel_type: 'special_needs', kennel_grad_status: 'graduated'    },
  'special needs - non graduate':{ kennel_type: 'special_needs', kennel_grad_status: 'non_graduate' },
  'special needs - in process':  { kennel_type: 'special_needs', kennel_grad_status: 'in_process'   },
  'special need':                { kennel_type: 'special_needs', kennel_grad_status: null            },
  'special needs':               { kennel_type: 'special_needs', kennel_grad_status: null            },
  'regular - graduated':         { kennel_type: 'regular',       kennel_grad_status: 'graduated'    },
  'regular - non graduate':      { kennel_type: 'regular',       kennel_grad_status: 'non_graduate' },
  'regular - in process':        { kennel_type: 'regular',       kennel_grad_status: 'in_process'   },
  'regular':                     { kennel_type: 'regular',       kennel_grad_status: null            },
  'small - graduated':           { kennel_type: 'small',         kennel_grad_status: 'graduated'    },
  'small - non graduate':        { kennel_type: 'small',         kennel_grad_status: 'non_graduate' },
  'small - in process':          { kennel_type: 'small',         kennel_grad_status: 'in_process'   },
  'small':                       { kennel_type: 'small',         kennel_grad_status: null            },
};

function resolveKennelCategory(contact) {
  if (!contact) return null;
  let raw = null;
  const customFields = contact.customFields || contact.customField || [];
  if (Array.isArray(customFields)) {
    for (const fieldId of CONFIG.KENNEL_SIZE_FIELD_IDS) {
      const entry = customFields.find(f => f.id === fieldId);
      const val = entry?.value || entry?.fieldValue || null;
      if (val) { raw = val; break; }
    }
  }
  if (!raw) {
    raw = contact['Kennel Category'] || contact['kennel_category'] || contact['kennel category'];
  }
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  return KENNEL_CATEGORY_MAP[key] || null;
}

const DOG_NAME_FIELD_IDS = ['MNwzpEaxKwgifkOsvhIb', '9m5zqCls4pQFTdlJJZaI'];
function resolveDogName(contact) {
  if (!contact) return null;
  const customFields = contact.customFields || contact.customField || [];
  if (!Array.isArray(customFields)) return null;

  for (const fieldId of DOG_NAME_FIELD_IDS) {
    const entry = customFields.find(f => f.id === fieldId);
    const value = entry?.value || entry?.fieldValue || null;
    if (value && String(value).trim()) return String(value).trim();
  }
  return null;
}

function resolveOwnerName(contact) {
  if (!contact) return null;
  const fullNameCandidates = [contact.name, contact.fullName, contact.full_name, contact.contactName];
  for (const candidate of fullNameCandidates) {
    if (candidate && String(candidate).trim()) return String(candidate).trim();
  }
  const first = contact.firstName || contact.first_name || contact.firstname || '';
  const last  = contact.lastName  || contact.last_name  || contact.lastname  || '';
  const combined = [first, last].filter(Boolean).join(' ').trim();
  return combined || null;
}

function getDateStringInTZ(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return formatter.format(date);
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

async function fetchAppointmentsForCalendar(calendarId) {
  const startTime = Date.now() - CONFIG.LOOKBACK_DAYS  * 86400000;
  const endTime   = Date.now() + CONFIG.LOOKAHEAD_DAYS * 86400000;
  try {
    const res = await ghl.get('/calendars/events', {
      params: { locationId: CONFIG.GHL_LOCATION, calendarId, startTime, endTime },
    });
    return res.data?.events || res.data?.appointments || [];
  } catch (err) {
    console.error(`Failed to fetch appointments for calendar ${calendarId}:`, err.response?.data || err.message);
    return [];
  }
}

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
// MAIN BACKFILL RUNNER
// ------------------------------------------------------------
async function backfill() {
  console.log(DRY_RUN ? 'Starting backfill (DRY RUN — no writes to Supabase)...\n' : 'Starting backfill...\n');

  let allAppointments = [];
  for (const calendarId of ALL_CALENDAR_IDS) {
    console.log(`Fetching appointments for calendar ${calendarId}...`);
    const appts = await fetchAppointmentsForCalendar(calendarId);
    console.log(`  -> found ${appts.length} appointments`);
    allAppointments.push(...appts.map(a => ({ ...a, calendarId: a.calendarId || calendarId })));
  }

  console.log(`\nTotal appointments fetched: ${allAppointments.length}\n`);
  if (allAppointments.length === 0) return;

  // Chronological queue sorted strictly by execution window (startTime) for historical tracking
  allAppointments.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  const stays = [];
  const MAX_STAY_SPAN_MS = 30 * 24 * 3600 * 1000; // 30 Day structural ceiling limit

  for (const appt of allAppointments) {
    const calMeta = CALENDAR_LOOKUP[appt.calendarId];
    if (!calMeta) continue;

    const { serviceType, role } = calMeta;
    const group = pairingGroupOf(serviceType);
    const isDropoff = role === 'dropoff';
    const missingField = isDropoff ? 'pickup' : 'dropoff';

    const contactId = appt.contactId;
    const apptTimeMs = new Date(appt.startTime).getTime();

    let bestMatch = null;
    let minDelta = Infinity;

    // Direct Time Alignment Matrix using execution schedules (startTime)
    for (const stay of stays) {
      if (stay.contactId !== contactId || stay.group !== group || stay[missingField]) continue;

      const targetLeg = stay.dropoff || stay.pickup;
      const targetTimeMs = new Date(targetLeg.startTime).getTime();
      const delta = Math.abs(targetTimeMs - apptTimeMs);

      // Check chronologically: dropoff must happen on/before pickup leg, bounded by the 30-day window
      if (delta <= MAX_STAY_SPAN_MS && delta < minDelta) {
        if (isDropoff && apptTimeMs <= targetTimeMs) {
          bestMatch = stay;
          minDelta = delta;
        } else if (!isDropoff && targetTimeMs <= apptTimeMs) {
          bestMatch = stay;
          minDelta = delta;
        }
      }
    }

    if (bestMatch) {
      if (isDropoff) {
        bestMatch.dropoff = appt;
        bestMatch.serviceType = serviceType; // Set service type from dropoff selection
      } else {
        bestMatch.pickup = appt;
      }
    } else {
      stays.push({
        contactId,
        serviceType,
        group,
        dropoff: isDropoff ? appt : null,
        pickup:  !isDropoff ? appt : null,
      });
    }
  }

  console.log(`Grouped into ${stays.length} clean stay structural groups\n`);

  let created = 0, updated = 0, incomplete = 0, errors = 0;

  for (const stay of stays) {
    const { dropoff, pickup, contactId, serviceType } = stay;
    const contact = await getContact(contactId);

    const dropoffMeta = dropoff ? CALENDAR_LOOKUP[dropoff.calendarId] : null;
    const pickupMeta  = pickup  ? CALENDAR_LOOKUP[pickup.calendarId]  : null;
    const source = (dropoffMeta?.source === 'online' || pickupMeta?.source === 'online') ? 'online' : 'internal';

    let status = 'confirmed';
    if (!dropoff || !pickup) status = 'incomplete';
    if (dropoff?.appointmentStatus === 'cancelled' || pickup?.appointmentStatus === 'cancelled') status = 'cancelled';

    const todayStr = getDateStringInTZ(new Date(), CONFIG.TIMEZONE);
    const startDate = dropoff?.startTime ? new Date(dropoff.startTime) : null;
    const endDate   = pickup?.startTime  ? new Date(pickup.startTime)  : null;
    const startStr  = startDate ? getDateStringInTZ(startDate, CONFIG.TIMEZONE) : null;
    const endStr    = endDate   ? getDateStringInTZ(endDate, CONFIG.TIMEZONE)   : null;

    if (status === 'confirmed' && startStr && endStr) {
      if (startStr <= todayStr && endStr >= todayStr) status = 'active';
      else if (endStr < todayStr) status = 'completed';
    }

    const cat = resolveKennelCategory(contact);
    
    // Defaulting to the execution timestamp anchor for backfilled sorting integrity
    const structuralBookedAt = dropoff?.startTime || pickup?.startTime || new Date().toISOString();

    const payload = {
      ghl_dropoff_appointment_id: dropoff?.id || null,
      ghl_pickup_appointment_id:  pickup?.id  || null,
      dropoff_calendar_id: dropoff?.calendarId || null,
      pickup_calendar_id:  pickup?.calendarId  || null,
      contact_id:   contactId,
      owner_name:   resolveOwnerName(contact),
      owner_email:  contact?.email || null,
      owner_phone:  contact?.phone || null,
      dog_name:     resolveDogName(contact),
      start_date:   dropoff?.startTime || null,
      end_date:     pickup?.startTime  || null,
      source,
      service_type: serviceType,
      status,
      is_returning_client: false,
      last_modified_source: 'ghl',
      last_synced_at: new Date().toISOString(),
      ghl_date_added: new Date(structuralBookedAt).toISOString(),
      kennel_type: cat?.kennel_type || null,
      kennel_grad_status: cat?.kennel_grad_status || null,
      kennel_status: cat?.kennel_type ? 'unassigned' : 'needs_size',
    };

    try {
      if (DRY_RUN) {
        console.log(`  [dry-run] would upsert ${contact?.name || contactId} — ${payload.start_date ? new Date(payload.start_date).toDateString() : '?'} -> ${payload.end_date ? new Date(payload.end_date).toDateString() : '?'} [${status}]`);
        if (status === 'incomplete') incomplete++;
        continue;
      }

      let existing = null;
      if (payload.ghl_dropoff_appointment_id) {
        const { data } = await supabase.from('boarding_stays').select('id, dog_name, owner_name').eq('ghl_dropoff_appointment_id', payload.ghl_dropoff_appointment_id).limit(1);
        if (data && data.length) existing = data[0];
      }
      if (!existing && payload.ghl_pickup_appointment_id) {
        const { data } = await supabase.from('boarding_stays').select('id, dog_name, owner_name').eq('ghl_pickup_appointment_id', payload.ghl_pickup_appointment_id).limit(1);
        if (data && data.length) existing = data[0];
      }

      if (existing) {
        if (!payload.dog_name && existing.dog_name) payload.dog_name = existing.dog_name;
        if (!payload.owner_name && existing.owner_name) payload.owner_name = existing.owner_name;
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
  console.log(`  Incomplete: ${incomplete}`);
  console.log(`  Errors:     ${errors}`);
  console.log(`========================================`);
}

backfill().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
