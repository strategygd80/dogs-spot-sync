// ============================================================
// The Dogs Spot — GHL Sync Backend
// Node.js / Express — deploy to Render or Railway (free tier)
// ============================================================
// Setup:
//   npm install express @supabase/supabase-js axios dotenv
//   node server.js
// ============================================================

require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ------------------------------------------------------------
// CORS — allow the portal (hosted anywhere, including file://)
// to call this API. Since this is an internal staff tool behind
// PIN auth, we allow all origins rather than maintaining an
// allowlist of hosting URLs.
// ------------------------------------------------------------
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ------------------------------------------------------------
// CONFIG — set these in your .env file
// ------------------------------------------------------------
const CONFIG = {
  GHL_TOKEN:      process.env.GHL_TOKEN,       // pit-ab470c39-...
  GHL_LOCATION:   process.env.GHL_LOCATION,    // BQHJ19uohldYe3eqA0bl
  SUPABASE_URL:   process.env.SUPABASE_URL,    // from Supabase project settings
  SUPABASE_KEY:   process.env.SUPABASE_KEY,    // service_role key (not anon)
  PORT:           process.env.PORT || 3000,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,  // optional: set in GHL webhook config

  // Calendar IDs — confirmed against GHL Settings → Calendars
  // Each service type has 4 calendars: in-person/online x drop-off/pick-up
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
      // No distinct online calendars found for Basic — confirm if these exist
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
      DROPOFF_INPERSON: 'ZqzoS3ckFZafZcaUKyOM',    // Bundle Drop Off — CONFIRM THIS ID, image was partially cut off
      PICKUP_INPERSON:  '2sAl9Q61WM2WNTqLqcGj',    // Bundle Pick-up
      DROPOFF_ONLINE:   null,
      PICKUP_ONLINE:    null,
    },
  },

  // Window in hours within which two appointments are considered part of the same booking
  PAIRING_WINDOW_HOURS: 2,

  // ------------------------------------------------------------
  // KENNEL INVENTORY — fixed physical capacity, matches the seeded
  // rows in the `kennels` table (see migration.sql): 20 large,
  // 20 medium, 10 small = 50 total.
  // ------------------------------------------------------------
  KENNEL_COUNTS: { regular: 20, special_needs: 10, small: 10 },

  // Custom field(s) on the GHL contact that store the dog's kennel
  // size (large/medium/small). Mirrors the DOG_NAME_FIELD_IDS pattern
  // above — CONFIRM THE REAL FIELD ID once you've located it in GHL
  // (Settings → Custom Fields) and replace the placeholder below.
  KENNEL_SIZE_FIELD_IDS: ['REPLACE_WITH_KENNEL_SIZE_FIELD_ID'],
};

// Build lookup maps: calendarId -> { serviceType, role }
const CALENDAR_LOOKUP = {};
for (const [serviceType, cals] of Object.entries(CONFIG.CALENDARS)) {
  if (cals.DROPOFF_INPERSON) CALENDAR_LOOKUP[cals.DROPOFF_INPERSON] = { serviceType, role: 'dropoff', source: 'internal' };
  if (cals.DROPOFF_ONLINE)   CALENDAR_LOOKUP[cals.DROPOFF_ONLINE]   = { serviceType, role: 'dropoff', source: 'online' };
  if (cals.PICKUP_INPERSON)  CALENDAR_LOOKUP[cals.PICKUP_INPERSON]  = { serviceType, role: 'pickup',  source: 'internal' };
  if (cals.PICKUP_ONLINE)    CALENDAR_LOOKUP[cals.PICKUP_ONLINE]    = { serviceType, role: 'pickup',  source: 'online' };
}

// ------------------------------------------------------------
// PAIRING GROUPS
// 'boarding' only pairs dropoff<->pickup within itself.
// The other five service types share one pool: a dropoff on any
// of them can pair with a pickup on any other (e.g. drop off as
// Basic, pick up as Bundle). Each service type maps to a group ID;
// only appointments in the same group are eligible to pair.
// ------------------------------------------------------------
const PAIRING_GROUPS = {
  boarding:    'boarding',
  basic:       'flexible',
  bundle:      'flexible',
  leash_free:  'flexible',
  service_dog: 'flexible',
  community:   'flexible',
};
function pairingGroupOf(serviceType) {
  return PAIRING_GROUPS[serviceType] || serviceType; // fall back to isolated pairing if unmapped
}
function serviceTypesInGroup(serviceType) {
  const group = pairingGroupOf(serviceType);
  return Object.keys(PAIRING_GROUPS).filter(st => PAIRING_GROUPS[st] === group);
}

// ------------------------------------------------------------
// NAME RESOLUTION
// GHL's contact API can return name fields under different keys
// depending on account/version. Rather than guessing one key,
// check every plausible variant so this works regardless.
// ------------------------------------------------------------
function resolveOwnerName(contact) {
  if (!contact) return null;

  const fullNameCandidates = [contact.name, contact.fullName, contact.full_name, contact.contactName];
  for (const candidate of fullNameCandidates) {
    if (candidate && String(candidate).trim()) return String(candidate).trim();
  }

  const first = contact.firstName || contact.first_name || contact.firstname || '';
  const last  = contact.lastName  || contact.last_name  || contact.lastname  || '';
  const combined = [first, last].filter(Boolean).join(' ').trim();
  if (combined) return combined;

  return null;
}

// ------------------------------------------------------------
// SUPABASE CLIENT
// ------------------------------------------------------------
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

// ------------------------------------------------------------
// GHL API CLIENT
// ------------------------------------------------------------
const ghl = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: {
    Authorization: `Bearer ${CONFIG.GHL_TOKEN}`,
    Version: '2021-04-15',
    'Content-Type': 'application/json',
  },
});

async function getAppointment(appointmentId) {
  const res = await ghl.get(`/calendars/events/appointments/${appointmentId}`);
  return res.data;
}

async function updateAppointment(appointmentId, payload) {
  const res = await ghl.put(`/calendars/events/appointments/${appointmentId}`, payload);
  return res.data;
}

async function getContactAppointments(contactId) {
  const res = await ghl.get(`/contacts/${contactId}/appointments`);
  return res.data?.appointments || [];
}

// ------------------------------------------------------------
// CUSTOM FIELD — DOG NAME
// Confirmed via direct lookup on a real contact (Scott Davenport,
// dog "Val") that GHL stores the dog's name under TWO custom field
// IDs that both held the same value for him:
//   MNwzpEaxKwgifkOsvhIb  (likely "Dog's Name")
//   9m5zqCls4pQFTdlJJZaI  (unconfirmed label, also held "Val")
// Rather than gamble on picking one, we check both and use whichever
// is non-empty — preferring the first if both are populated.
// ------------------------------------------------------------
const DOG_NAME_FIELD_IDS = ['MNwzpEaxKwgifkOsvhIb', '9m5zqCls4pQFTdlJJZaI'];

function resolveDogName(contact) {
  if (!contact) return null;

  // Flat webhook format — GHL sends custom fields as named top-level keys
  const flatDog = contact["Dog's Name"] || contact['dogs_name'] || contact['dog_name'];
  if (flatDog && String(flatDog).trim()) return String(flatDog).trim();

  // Contact API format — customFields array of {id, value}
  const customFields = contact.customFields || contact.customField || [];
  if (Array.isArray(customFields)) {
    for (const fieldId of DOG_NAME_FIELD_IDS) {
      const entry = customFields.find(f => f.id === fieldId);
      const value = entry?.value || entry?.fieldValue || null;
      if (value && String(value).trim()) return String(value).trim();
    }
  }
  return null;
}

// ------------------------------------------------------------
// CUSTOM FIELD — KENNEL SIZE
// Reads the dog's kennel size off the GHL contact so every stay can
// be auto-assigned a physical kennel without staff re-entering it.
// Accepts loose values ("L", "Large", "large") and normalises them
// to one of: large / medium / small. Returns null if the field is
// missing or unrecognized — the stay then gets flagged as
// kennel_status='needs_size' for a human to resolve.
// ------------------------------------------------------------
// ------------------------------------------------------------
// KENNEL CATEGORY MAPPING
// GHL stores {{contact.kennel_category}} as a combined string
// that encodes both the physical kennel type AND the dog's
// graduation status. We split these into two separate fields:
//   kennel_type       → which physical kennel section the dog uses
//   kennel_grad_status → where the dog is in the program
// ------------------------------------------------------------
const KENNEL_CATEGORY_MAP = {
  // Special Needs
  'special need - graduated':    { kennel_type: 'special_needs', kennel_grad_status: 'graduated'    },
  'special need - non graduate': { kennel_type: 'special_needs', kennel_grad_status: 'non_graduate' },
  'special need - in process':   { kennel_type: 'special_needs', kennel_grad_status: 'in_process'   },
  'special needs - graduated':   { kennel_type: 'special_needs', kennel_grad_status: 'graduated'    },
  'special needs - non graduate':{ kennel_type: 'special_needs', kennel_grad_status: 'non_graduate' },
  'special needs - in process':  { kennel_type: 'special_needs', kennel_grad_status: 'in_process'   },
  'special need':                { kennel_type: 'special_needs', kennel_grad_status: null            },
  'special needs':               { kennel_type: 'special_needs', kennel_grad_status: null            },
  // Regular
  'regular - graduated':         { kennel_type: 'regular',       kennel_grad_status: 'graduated'    },
  'regular - non graduate':      { kennel_type: 'regular',       kennel_grad_status: 'non_graduate' },
  'regular - in process':        { kennel_type: 'regular',       kennel_grad_status: 'in_process'   },
  'regular':                     { kennel_type: 'regular',       kennel_grad_status: null            },
  // Small
  'small - graduated':           { kennel_type: 'small',         kennel_grad_status: 'graduated'    },
  'small - non graduate':        { kennel_type: 'small',         kennel_grad_status: 'non_graduate' },
  'small - in process':          { kennel_type: 'small',         kennel_grad_status: 'in_process'   },
  'small':                       { kennel_type: 'small',         kennel_grad_status: null            },
};

// Returns { kennel_type, kennel_grad_status } or null if unrecognized.
// Handles both the flat webhook payload format (top-level named keys)
// and the contact API format (customFields array of {id, value}).
function resolveKennelCategory(contact, flatPayload) {
  let raw = null;

  // Try flat webhook payload first — GHL sends custom fields as top-level
  // named keys in webhook bodies e.g. { "Kennel Category": "Regular - Graduated" }
  if (flatPayload) {
    raw = flatPayload['Kennel Category'] || flatPayload['kennel_category'] || flatPayload['kennel category'];
  }

  // Fall back to contact API format (array of {id, value})
  if (!raw && contact) {
    const customFields = contact.customFields || contact.customField || [];
    if (Array.isArray(customFields)) {
      for (const fieldId of CONFIG.KENNEL_SIZE_FIELD_IDS) {
        const entry = customFields.find(f => f.id === fieldId);
        const val = entry?.value || entry?.fieldValue || null;
        if (val) { raw = val; break; }
      }
    }
    // Also check flat keys on the contact object itself
    if (!raw) {
      raw = contact['Kennel Category'] || contact['kennel_category'];
    }
  }

  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  return KENNEL_CATEGORY_MAP[key] || null;
}

// Convenience wrapper — returns just the kennel_type string (for
// backwards-compatible calls that only need the physical type).
function resolveKennelType(contact, flatPayload) {
  return resolveKennelCategory(contact, flatPayload)?.kennel_type || null;
}

async function getContact(contactId) {
  const res = await ghl.get(`/contacts/${contactId}`);
  return res.data?.contact || null;
}

// ------------------------------------------------------------
// RETURNING CLIENT CHECK
// A contact is "returning" if they have at least one prior
// completed boarding stay in our DB (more reliable than GHL tags)
// ------------------------------------------------------------
async function isReturningClient(contactId) {
  const { data, error } = await supabase
    .from('boarding_stays')
    .select('id')
    .eq('contact_id', contactId)
    .in('status', ['completed', 'active', 'confirmed'])
    .limit(1);

  if (error) return false;
  return data.length > 0;
}

// ------------------------------------------------------------
// PAIRING ENGINE
// Finds an existing incomplete stay for the same contact to pair
// this appointment with. Two very different pairing behaviors
// depending on service group:
//
// BOARDING — drop-off and pick-up are booked by the customer in
//   the SAME GHL session, so we anchor on ghl_date_added (when GHL
//   says the appointment was booked) and require both legs to fall
//   within a tight time window of each other. This is immune to
//   webhook delivery delays, but still scoped tightly because a
//   customer could legitimately book two separate unrelated
//   boarding stays for the same dog on the same day.
//
// FLEXIBLE (basic, bundle, leash_free, service_dog, community) —
//   these are booked as INDEPENDENT, STANDALONE appointments,
//   often days apart, and the customer can mix types freely
//   (e.g. drop off as Basic, pick up as Community). There is NO
//   reliable time relationship between the two legs, so we do NOT
//   apply any time window at all. Instead we match the OLDEST
//   unpaired appointment of any type in the flexible group for
//   this contact (FIFO) — the longest-waiting incomplete leg gets
//   completed first, which mirrors how staff actually think about
//   "this dog has been dropped off and is still here."
// ------------------------------------------------------------
const BOARDING_PAIRING_WINDOW_HOURS = 24;

async function findPairableStay(contactId, appointmentBookedAt, role, serviceType) {
  const group = pairingGroupOf(serviceType);

  // The field that must be NULL — we are filling in the missing half.
  // (This must match our OWN role's field: a dropoff appointment should
  // pair with a stay that already has a pickup but is still missing its
  // dropoff, and vice versa.)
  const missingField = role === 'dropoff'
    ? 'ghl_dropoff_appointment_id'  // we are the dropoff; find row still missing its dropoff
    : 'ghl_pickup_appointment_id';  // we are the pickup;  find row still missing its pickup

  let query = supabase
    .from('boarding_stays')
    .select('*')
    .eq('contact_id', contactId)
    .eq('status', 'incomplete')
    .in('service_type', serviceTypesInGroup(serviceType))
    .is(missingField, null);

  if (group === 'boarding') {
    // Tight proximity window anchored on GHL's own booking timestamp.
    const bookedAt    = new Date(appointmentBookedAt);
    const windowStart = new Date(bookedAt.getTime() - BOARDING_PAIRING_WINDOW_HOURS * 3600 * 1000);
    const windowEnd   = new Date(bookedAt.getTime() + BOARDING_PAIRING_WINDOW_HOURS * 3600 * 1000);
    query = query
      .gte('ghl_date_added', windowStart.toISOString())
      .lte('ghl_date_added', windowEnd.toISOString())
      .order('ghl_date_added', { ascending: false });
  } else {
    // Flexible group: no time window. Oldest unpaired leg wins (FIFO),
    // since these can be created on completely different dates.
    query = query.order('ghl_date_added', { ascending: true });
  }

  const { data, error } = await query.limit(1);

  if (error || !data || data.length === 0) return null;
  return data[0];
}

// ------------------------------------------------------------
// SYNC LOG HELPER
// ------------------------------------------------------------
async function logSync({ stayId, ghlAppointmentId, direction, action, payload, status = 'success', errorMessage = null }) {
  await supabase.from('sync_log').insert({
    stay_id: stayId || null,
    ghl_appointment_id: ghlAppointmentId || null,
    direction,
    action,
    payload,
    status,
    error_message: errorMessage,
  });
}

// ------------------------------------------------------------
// KENNEL ASSIGNMENT ENGINE
// 50 physical kennels total: 20 large, 20 medium, 10 small (see
// CONFIG.KENNEL_COUNTS and the `kennels` table in migration.sql).
// Every stay that has a start_date gets matched to one specific
// kennel for its whole date range. If none of the right size is
// free, or the dog's size isn't on file, the stay is flagged
// (kennel_status = 'unassigned' / 'needs_size') so staff can see
// the shortfall on the Kennels page and resolve it manually.
// ------------------------------------------------------------
async function getAllKennels() {
  const { data, error } = await supabase.from('kennels').select('*').eq('active', true).order('label');
  if (error) throw error;
  return data || [];
}

// Two date ranges overlap if each starts on/before the other's end.
// A stay with no end_date yet is treated as open-ended (blocks forward
// indefinitely) since we don't know when the dog is leaving.
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  const aE = aEnd || '9999-12-31';
  const bE = bEnd || '9999-12-31';
  return aStart <= bE && bStart <= aE;
}

async function findAvailableKennel(kennelType, startDate, endDate, excludeStayId) {
  if (!startDate) return null;
  const kennels = (await getAllKennels()).filter(k => k.type === kennelType);
  if (!kennels.length) return null;

  const { data: occupied, error } = await supabase
    .from('boarding_stays')
    .select('id, kennel_id, start_date, end_date, status')
    .not('kennel_id', 'is', null);
  if (error) throw error;

  const busyKennelIds = new Set(
    (occupied || [])
      .filter(s => s.id !== excludeStayId)
      .filter(s => !['cancelled', 'completed'].includes(s.status))
      .filter(s => s.start_date && rangesOverlap(startDate, endDate, s.start_date, s.end_date))
      .map(s => s.kennel_id)
  );

  return kennels.find(k => !busyKennelIds.has(k.id)) || null;
}

// Determines the right kennel_id / kennel_type / kennel_status for a
// stay, without writing to the DB. Pure function of (stay, GHL contact).
async function computeKennelAssignment(stay) {
  if (!stay.start_date) {
    return { kennel_id: null, kennel_type: stay.kennel_type || null, kennel_status: 'needs_size' };
  }

  let kennelType = stay.kennel_type;
  if (!kennelType) {
    const contact = await getContact(stay.contact_id).catch(() => null);
    kennelType = resolveKennelType(contact);
  }

  if (!kennelType) {
    return { kennel_id: null, kennel_type: null, kennel_status: 'needs_size' };
  }

  const kennel = await findAvailableKennel(kennelType, stay.start_date, stay.end_date, stay.id);
  if (!kennel) {
    return { kennel_id: null, kennel_type: kennelType, kennel_status: 'unassigned' };
  }
  return { kennel_id: kennel.id, kennel_type: kennelType, kennel_status: 'assigned' };
}

// Loads a stay by id, computes its kennel assignment, writes the
// result back, and logs a flagged event if it couldn't be fully
// assigned. Safe to call any time a stay's dates or size become
// known (webhook create/update/pair, or after a manual edit).
async function assignKennelAndSave(stayId) {
  const { data: stay, error } = await supabase.from('boarding_stays').select('*').eq('id', stayId).single();
  if (error || !stay) return null;

  const result = await computeKennelAssignment(stay);
  await supabase.from('boarding_stays').update(result).eq('id', stayId);

  if (result.kennel_status !== 'assigned') {
    await logSync({
      stayId,
      direction: 'db_to_ghl',
      action: result.kennel_status === 'needs_size' ? 'kennel flagged — no size on file' : 'kennel flagged — no availability',
      payload: { kennel_type: result.kennel_type },
      status: 'failed',
      errorMessage: result.kennel_status === 'needs_size'
        ? 'Dog size not found on GHL contact'
        : `No ${result.kennel_type} kennel available for these dates`,
    });
  }
  return result;
}

// Kennel occupancy snapshot for a single date — used by both the
// dashboard endpoint and the dedicated /api/kennels/occupancy route.
async function getKennelOccupancySummary(dateStr) {
  const kennels = await getAllKennels();
  const { data: stays, error } = await supabase.from('boarding_stays').select('*');
  if (error) throw error;

  const live = (stays || []).filter(s => !['cancelled', 'completed'].includes(s.status));

  const occupying = live.filter(s =>
    s.kennel_id && s.start_date && s.start_date <= dateStr && (!s.end_date || s.end_date >= dateStr)
  );
  const byKennel = {};
  occupying.forEach(s => { byKennel[s.kennel_id] = s; });

  const flagged = live.filter(s =>
    s.start_date && s.start_date <= dateStr && (!s.end_date || s.end_date >= dateStr) &&
    s.kennel_status && s.kennel_status !== 'assigned'
  );

  const summary = { large: { total: 0, filled: 0 }, medium: { total: 0, filled: 0 }, small: { total: 0, filled: 0 } };
  kennels.forEach(k => {
    if (!summary[k.type]) return;
    summary[k.type].total++;
    if (byKennel[k.id]) summary[k.type].filled++;
  });

  return {
    date: dateStr,
    summary,
    kennels: kennels.map(k => ({
      ...k,
      occupiedBy: byKennel[k.id] ? {
        id: byKennel[k.id].id, dogName: byKennel[k.id].dog_name, ownerName: byKennel[k.id].owner_name,
        startDate: byKennel[k.id].start_date, endDate: byKennel[k.id].end_date,
      } : null,
    })),
    flagged,
  };
}

// ------------------------------------------------------------
// DETERMINE STATUS
// ------------------------------------------------------------
async function determineStatus(source, contactId) {
  if (source === 'internal') return 'confirmed';
  const returning = await isReturningClient(contactId);
  return returning ? 'confirmed' : 'requested';
}

// ------------------------------------------------------------
// PROCESS APPOINTMENT CREATED / UPDATED
// ------------------------------------------------------------
async function processAppointment(payload, eventType) {
  const {
    id: ghlAppointmentId,
    calendarId,
    contactId,
    startTime,
    endTime,
    status: ghlStatus,
    dateAdded,
    _flatContact,  // raw GHL workflow body — used for flat custom field resolution
  } = payload;

  // Pre-filled contact info from workflow webhook (saves a GHL API call)
  const prefilled = _flatContact ? {
    name:  _flatContact.full_name || [_flatContact.first_name, _flatContact.last_name].filter(Boolean).join(' ') || null,
    email: _flatContact.email || null,
    phone: _flatContact.phone || null,
  } : null;

  // Normalise: fall back to now only if GHL omits the field entirely
  const appointmentBookedAt = dateAdded ? new Date(dateAdded).toISOString() : new Date().toISOString();

  // Determine role + service type of this appointment via lookup map
  const calMeta = CALENDAR_LOOKUP[calendarId];

  if (!calMeta) {
    console.log(`Ignoring appointment from unrecognized calendar: ${calendarId}`);
    return;
  }

  const { serviceType, role, source } = calMeta;

  // Check if this appointment already exists in DB (update scenario)
  const existingField = role === 'dropoff' ? 'ghl_dropoff_appointment_id' : 'ghl_pickup_appointment_id';
  const { data: existingStays } = await supabase
    .from('boarding_stays')
    .select('*')
    .eq(existingField, ghlAppointmentId)
    .limit(1);

  if (existingStays && existingStays.length > 0) {
    // UPDATE existing stay
    const stay = existingStays[0];
    const updatePayload = {
      [role === 'dropoff' ? 'start_date' : 'end_date']: role === 'dropoff' ? startTime : endTime,
      // Always refresh ghl_date_added so the stored value matches what GHL
      // is currently reporting — useful if the appointment was rebooked.
      ghl_date_added: appointmentBookedAt,
      last_modified_source: 'ghl',
      last_synced_at: new Date().toISOString(),
    };

    // If GHL status is cancelled, propagate
    if (ghlStatus === 'cancelled') updatePayload.status = 'cancelled';

    await supabase.from('boarding_stays').update(updatePayload).eq('id', stay.id);
    // Dates may have shifted (reschedule from GHL) — re-check kennel availability.
    if (updatePayload.status !== 'cancelled') await assignKennelAndSave(stay.id).catch(err => console.error('Kennel assignment error:', err.message));
    await logSync({ stayId: stay.id, ghlAppointmentId, direction: 'ghl_to_db', action: eventType === 'AppointmentCreate' ? 'created' : 'updated', payload });
    console.log(`Updated stay ${stay.id} from GHL (${role})`);
    return;
  }

  // NEW appointment — try to pair with existing incomplete stay.
  // Pass the GHL dateAdded timestamp so pairing is based on when the
  // customer booked both appointments (same session), not when our
  // webhooks happened to fire.
  const pairableStay = await findPairableStay(contactId, appointmentBookedAt, role, serviceType);

  if (pairableStay) {
    // PAIR: merge this appointment into existing incomplete stay
    // Use prefilled contact data from workflow webhook if available,
    // fall back to a GHL API call only when needed.
    const contact = (!prefilled || !resolveDogName(_flatContact))
      ? await getContact(contactId).catch(() => null)
      : null;
    const status  = await determineStatus(source, contactId);

    const updatePayload = {
      [existingField]: ghlAppointmentId,
      [role === 'dropoff' ? 'dropoff_calendar_id' : 'pickup_calendar_id']: calendarId,
      [role === 'dropoff' ? 'start_date' : 'end_date']: role === 'dropoff' ? startTime : endTime,
      source,
      // service_type reflects the dropoff leg (when the dog actually
      // arrived), not whichever leg happens to sync last. If this
      // appointment is a pickup completing a cross-paired stay (e.g.
      // dropped off as Basic, picked up as Bundle), keep the original.
      service_type: role === 'dropoff' ? serviceType : pairableStay.service_type,
      status: pairableStay.status === 'incomplete' ? status : pairableStay.status,
      is_returning_client: status === 'confirmed' && source === 'online',
      last_modified_source: 'ghl',
      last_synced_at: new Date().toISOString(),
      // Fill contact info — prefer flat webhook fields, fall back to API
      owner_name:  pairableStay.owner_name  || prefilled?.name  || resolveOwnerName(contact),
      owner_email: pairableStay.owner_email || prefilled?.email || contact?.email || null,
      owner_phone: pairableStay.owner_phone || prefilled?.phone || contact?.phone || null,
      dog_name:    pairableStay.dog_name    || resolveDogName(_flatContact) || resolveDogName(contact),
      // Keep the earliest dateAdded — the first leg of the pair was booked
      // at this moment; the second leg may be fractionally later.
      ghl_date_added: pairableStay.ghl_date_added || appointmentBookedAt,
      // Kennel size, if not already known, resolved from the GHL contact.
      // Kennel category — resolve from contact API or flat webhook payload
      ...(() => {
        const cat = resolveKennelCategory(contact, payload) ||
                    (pairableStay.kennel_type ? { kennel_type: pairableStay.kennel_type, kennel_grad_status: pairableStay.kennel_grad_status } : null);
        return cat ? { kennel_type: cat.kennel_type, kennel_grad_status: cat.kennel_grad_status } : {};
      })(),
    };

    await supabase.from('boarding_stays').update(updatePayload).eq('id', pairableStay.id);
    await assignKennelAndSave(pairableStay.id).catch(err => console.error('Kennel assignment error:', err.message));
    await logSync({ stayId: pairableStay.id, ghlAppointmentId, direction: 'ghl_to_db', action: 'paired', payload });
    console.log(`Paired ${role} appointment into stay ${pairableStay.id}`);
  } else {
    // CREATE new incomplete stay (first half of pair)
    // Use prefilled contact data from workflow webhook if available,
    // fall back to a GHL API call only when needed.
    const contact = (!prefilled || !resolveDogName(_flatContact))
      ? await getContact(contactId).catch(() => null)
      : null;

    const insertPayload = {
      contact_id:   contactId,
      owner_name:   prefilled?.name  || resolveOwnerName(contact),
      owner_email:  prefilled?.email || contact?.email || null,
      owner_phone:  prefilled?.phone || contact?.phone || null,
      dog_name:     resolveDogName(_flatContact) || resolveDogName(contact),
      source,
      service_type: serviceType,
      status: 'incomplete',
      last_modified_source: 'ghl',
      last_synced_at: new Date().toISOString(),
      // Store the GHL booking timestamp — this is the anchor for pairing
      // when the second leg (pickup or dropoff) arrives via webhook.
      ghl_date_added: appointmentBookedAt,
      // Kennel size resolved from the GHL contact, if available. If it's
      // still incomplete (missing dates) no kennel is assigned yet, but
      // storing the type now saves an extra GHL lookup once it's paired.
      // Kennel category — resolve from contact API or flat webhook payload.
      // Stores kennel_type (physical section) and kennel_grad_status separately.
      ...(() => {
        const cat = resolveKennelCategory(contact, payload);
        return cat ? { kennel_type: cat.kennel_type, kennel_grad_status: cat.kennel_grad_status } : {};
      })(),
      kennel_status: 'needs_size',
      [existingField]: ghlAppointmentId,
      [role === 'dropoff' ? 'dropoff_calendar_id' : 'pickup_calendar_id']: calendarId,
      [role === 'dropoff' ? 'start_date' : 'end_date']: role === 'dropoff' ? startTime : endTime,
    };

    const { data: newStay, error } = await supabase
      .from('boarding_stays')
      .insert(insertPayload)
      .select()
      .single();

    if (error) throw error;

    await assignKennelAndSave(newStay.id).catch(err => console.error('Kennel assignment error:', err.message));
    await logSync({ stayId: newStay.id, ghlAppointmentId, direction: 'ghl_to_db', action: 'created', payload });
    console.log(`Created incomplete stay ${newStay.id} waiting for ${role === 'dropoff' ? 'pickup' : 'dropoff'}`);
  }
}

// ------------------------------------------------------------
// PROCESS CANCELLATION
// ------------------------------------------------------------
async function processCancellation(payload) {
  const { id: ghlAppointmentId } = payload;

  // Find stay by either appointment ID
  const { data: stays } = await supabase
    .from('boarding_stays')
    .select('*')
    .or(`ghl_dropoff_appointment_id.eq.${ghlAppointmentId},ghl_pickup_appointment_id.eq.${ghlAppointmentId}`)
    .limit(1);

  if (!stays || stays.length === 0) {
    console.log(`No stay found for cancelled appointment ${ghlAppointmentId}`);
    return;
  }

  const stay = stays[0];
  await supabase.from('boarding_stays').update({
    status: 'cancelled',
    last_modified_source: 'ghl',
    last_synced_at: new Date().toISOString(),
  }).eq('id', stay.id);

  await logSync({ stayId: stay.id, ghlAppointmentId, direction: 'ghl_to_db', action: 'cancelled', payload });
  console.log(`Cancelled stay ${stay.id}`);
}

// ------------------------------------------------------------
// WEBHOOK ENDPOINT (GHL → DB)
// Configure this URL in GHL: Settings → Webhooks
// Events: AppointmentCreate, AppointmentUpdate, AppointmentDelete
//
// SECURITY: if WEBHOOK_SECRET is set, GHL must send it back on every
// request (as either a query param ?secret=... or header
// x-webhook-secret) or the request is rejected before any DB write
// happens. Without this check, anyone who discovers this URL could
// POST fake appointment data and corrupt the boarding_stays table.
// ------------------------------------------------------------
app.post('/webhook/ghl', async (req, res) => {
  if (CONFIG.WEBHOOK_SECRET) {
    const providedSecret = req.query.secret || req.headers['x-webhook-secret'];
    if (providedSecret !== CONFIG.WEBHOOK_SECRET) {
      console.warn('Rejected webhook: missing or invalid secret');
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }
  }

  // Acknowledge immediately so GHL doesn't retry
  res.status(200).json({ received: true });

  // DEBUG — log the full raw payload so we can see exactly what GHL sends
  console.log('RAW WEBHOOK BODY:', JSON.stringify(req.body, null, 2));

  const body = req.body;

  // ── NORMALISE GHL WEBHOOK FORMAT ──────────────────────────────────
  // GHL sends two very different shapes depending on how the webhook
  // was configured:
  //
  // FORMAT A — Standard appointment webhook (Settings → Webhooks):
  //   { type: 'AppointmentCreate', id: '...', calendarId: '...', ... }
  //
  // FORMAT B — Workflow webhook (Automation → Workflow → Webhook action):
  //   All appointment data is nested under `calendar`, contact fields
  //   are flat at the top level, and there is NO `type` field at all.
  //   { calendar: { appointmentId, calendarId, startTime, status, ... },
  //     contact_id: '...', first_name: '...', 'Kennel Category': '...' }
  //
  // We detect Format B by the presence of `body.calendar.appointmentId`
  // and normalise everything into the shape processAppointment expects.
  // ─────────────────────────────────────────────────────────────────

  let type, payload;

  if (body.calendar && body.calendar.appointmentId) {
    // FORMAT B — workflow webhook
    const cal = body.calendar;

    // Determine event type from appointment status
    // GHL workflow webhooks don't have an explicit create/update flag,
    // so we treat every incoming workflow event as an upsert — if the
    // appointment already exists in the DB it updates, otherwise creates.
    const apptStatus = (cal.appoinmentStatus || cal.appointmentStatus || cal.status || '').toLowerCase();
    type = apptStatus === 'cancelled' ? 'AppointmentDelete' : 'AppointmentCreate';

    payload = {
      // Core appointment fields from the nested calendar object
      id:         cal.appointmentId,
      calendarId: cal.id,
      startTime:  cal.startTime,
      endTime:    cal.endTime,
      status:     apptStatus,
      dateAdded:  cal.date_created || body.date_created,
      title:      cal.title,

      // Contact fields from the flat top level
      contactId:  body.contact_id,
      ownerName:  body.full_name || [body.first_name, body.last_name].filter(Boolean).join(' '),
      ownerEmail: body.email,
      ownerPhone: body.phone,

      // Pass the full body so resolveKennelCategory / resolveDogName
      // can read flat custom fields like "Kennel Category", "Dog's Name"
      _flatContact: body,
    };

    console.log(`Workflow webhook → normalised as ${type} — appointmentId: ${payload.id} calendarId: ${payload.calendarId}`);

  } else {
    // FORMAT A — standard appointment webhook
    type = body.type || body.eventType || body.event || body.eventName;
    const appointmentId = body.id || body.appointmentId || body.appointment_id;

    payload = {
      ...body,
      id:         appointmentId,
      contactId:  body.contactId  || body.contact_id,
      calendarId: body.calendarId || body.calendar_id,
      startTime:  body.startTime  || body.start_time,
      endTime:    body.endTime    || body.end_time,
      status:     body.status     || body.appointmentStatus,
      dateAdded:  body.dateAdded  || body.date_added || body.createdAt,
      _flatContact: body,
    };

    console.log(`Standard webhook: ${type} — appointmentId: ${appointmentId}`);
  }

  try {
    if (type === 'AppointmentCreate' || type === 'AppointmentUpdate') {
      await processAppointment(payload, type);
    } else if (type === 'AppointmentDelete' || payload?.status === 'cancelled') {
      await processCancellation(payload);
    }
  } catch (err) {
    console.error(`Webhook processing error for ${type}:`, err.message);
    await logSync({
      ghlAppointmentId: payload?.id,
      direction: 'ghl_to_db',
      action: type?.toLowerCase() || 'unknown',
      payload: req.body,
      status: 'failed',
      errorMessage: err.message,
    });
  }
});

// ------------------------------------------------------------
// PORTAL API ROUTES (Portal → DB → GHL)
// All routes prefixed /api — consumed by the portal frontend
// ------------------------------------------------------------

// GET all stays with optional filters
app.get('/api/stays', async (req, res) => {
  try {
    const { status, source, serviceType, from, to, search, kennelType, kennelStatus } = req.query;
    let query = supabase.from('boarding_stays').select('*').order('start_date', { ascending: true });

    if (status)      query = query.eq('status', status);
    if (source)      query = query.eq('source', source);
    if (serviceType) query = query.eq('service_type', serviceType);
    if (kennelType)  query = query.eq('kennel_type', kennelType);
    if (kennelStatus) query = query.eq('kennel_status', kennelStatus);
    if (from)        query = query.gte('start_date', from);
    if (to)          query = query.lte('start_date', to);
    if (search)       query = query.or(`owner_name.ilike.%${search}%,dog_name.ilike.%${search}%`);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET today's dashboard summary
// Timezone-aware date string helper (matches business location: Savannah, GA = America/New_York)
const BUSINESS_TIMEZONE = 'America/New_York';
function getDateStringInTZ(date, timeZone = BUSINESS_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return formatter.format(date); // YYYY-MM-DD
}

// Shared helper — build dashboard payload for any target date (YYYY-MM-DD string).
// If targetDateStr is omitted, defaults to today in the business timezone.
async function buildDashboardForDate(targetDateStr) {
  const now = new Date();
  const resolvedDate = targetDateStr || getDateStringInTZ(now);

  // Build a Date from the YYYY-MM-DD string so we can compute the next day safely.
  // Append T12:00:00 to avoid any UTC-boundary drift when parsing as local time.
  const targetDate  = new Date(`${resolvedDate}T12:00:00`);
  const nextDate    = new Date(targetDate.getTime() + 86400000);
  const nextDateStr = getDateStringInTZ(nextDate);

  const { data: allStays } = await supabase
    .from('boarding_stays')
    .select('*')
    .neq('status', 'cancelled');

  const arrivals   = (allStays || []).filter(s => s.start_date && getDateStringInTZ(new Date(s.start_date)) === resolvedDate);
  const departures = (allStays || []).filter(s => s.end_date   && getDateStringInTZ(new Date(s.end_date))   === resolvedDate);

  const active = (allStays || []).filter(s => {
    if (!s.start_date) return false;
    const startStr = getDateStringInTZ(new Date(s.start_date));
    if (startStr > resolvedDate) return false;
    if (!s.end_date) return true;
    const endStr = getDateStringInTZ(new Date(s.end_date));
    return endStr >= resolvedDate;
  });

  const [pendingRes, incompleteRes] = await Promise.all([
    supabase.from('boarding_stays').select('*').eq('status', 'requested'),
    supabase.from('boarding_stays').select('*').eq('status', 'incomplete'),
  ]);

  const kennelOccupancy = await getKennelOccupancySummary(resolvedDate);

  return {
    date: resolvedDate,
    arrivals,
    departures,
    active,
    pending:    pendingRes.data    || [],
    incomplete: incompleteRes.data || [],
    counts: {
      arrivals:   arrivals.length,
      departures: departures.length,
      active:     active.length,
      pending:    pendingRes.data?.length    || 0,
      incomplete: incompleteRes.data?.length || 0,
    },
    kennelOccupancy,
  };
}

app.get('/api/dashboard/today', async (req, res) => {
  try {
    // Support optional ?date=YYYY-MM-DD so a single endpoint powers both
    // "today" and any date the portal's date-picker selects.
    const { date } = req.query;
    const payload = await buildDashboardForDate(date || null);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET kennel inventory (the 50-kennel list)
app.get('/api/kennels', async (req, res) => {
  try {
    const kennels = await getAllKennels();
    res.json(kennels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET kennel occupancy for a given date (defaults to today) — powers the Kennels page
app.get('/api/kennels/occupancy', async (req, res) => {
  try {
    const dateStr = req.query.date || getDateStringInTZ(new Date());
    const payload = await getKennelOccupancySummary(dateStr);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH — manually assign/reassign/clear a stay's kennel (staff override)
app.patch('/api/stays/:id/kennel', async (req, res) => {
  try {
    const { id } = req.params;
    const { kennel_id } = req.body; // null/omitted clears the assignment
    const { data: stay, error } = await supabase.from('boarding_stays').select('*').eq('id', id).single();
    if (error || !stay) return res.status(404).json({ error: 'Stay not found' });

    if (kennel_id) {
      const { data: kennel, error: kErr } = await supabase.from('kennels').select('*').eq('id', kennel_id).single();
      if (kErr || !kennel) return res.status(404).json({ error: 'Kennel not found' });

      const available = await findAvailableKennel(kennel.type, stay.start_date, stay.end_date, stay.id);
      if (!available || available.id !== kennel_id) {
        console.warn(`Manual kennel assignment: ${kennel_id} for stay ${id} overlaps another stay's dates — proceeding anyway per staff override.`);
      }

      await supabase.from('boarding_stays').update({
        kennel_id, kennel_type: kennel.type, kennel_status: 'assigned',
        last_modified_source: 'portal', last_synced_at: new Date().toISOString(),
      }).eq('id', id);
    } else {
      await supabase.from('boarding_stays').update({
        kennel_id: null,
        kennel_status: stay.kennel_type ? 'unassigned' : 'needs_size',
        last_modified_source: 'portal', last_synced_at: new Date().toISOString(),
      }).eq('id', id);
    }

    await logSync({ stayId: id, direction: 'db_to_ghl', action: 'kennel reassigned', payload: req.body, status: 'success' });
    res.json({ success: true });
  } catch (err) {
    await logSync({ stayId: req.params.id, direction: 'db_to_ghl', action: 'kennel reassigned', payload: req.body, status: 'failed', errorMessage: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST — backfill kennel assignments for every existing stay that
// doesn't have one yet (run once after deploying this feature, and
// any time you want to re-sweep for newly-freed kennels).
app.post('/api/kennels/backfill', async (req, res) => {
  try {
    const { data: stays, error } = await supabase
      .from('boarding_stays')
      .select('id')
      .not('status', 'in', '(cancelled,completed)')
      .neq('kennel_status', 'assigned');
    if (error) throw error;

    const results = { total: stays.length, assigned: 0, unassigned: 0, needsSize: 0 };
    for (const s of stays) {
      const outcome = await assignKennelAndSave(s.id).catch(() => null);
      if (!outcome) continue;
      if (outcome.kennel_status === 'assigned') results.assigned++;
      else if (outcome.kennel_status === 'unassigned') results.unassigned++;
      else results.needsSize++;
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET reporting totals
app.get('/api/dashboard/reporting', async (req, res) => {
  try {
    const { from, to } = req.query;
    let query = supabase.from('boarding_stays').select('*');
    if (from) query = query.gte('start_date', from);
    if (to)   query = query.lte('start_date', to);

    const { data, error } = await query;
    if (error) throw error;

    const totals = {
      total:      data.length,
      confirmed:  data.filter(s => s.status === 'confirmed').length,
      active:     data.filter(s => s.status === 'active').length,
      completed:  data.filter(s => s.status === 'completed').length,
      cancelled:  data.filter(s => s.status === 'cancelled').length,
      requested:  data.filter(s => s.status === 'requested').length,
      online:     data.filter(s => s.source === 'online').length,
      internal:   data.filter(s => s.source === 'internal').length,
      newClients: data.filter(s => !s.is_returning_client).length,
      returning:  data.filter(s => s.is_returning_client).length,
    };

    // How many bookings in this range used each kennel size, plus how
    // many were flagged (no size on file / no kennel available) —
    // distinct from the live "kennels filled right now" snapshot below.
    const kennelBreakdown = {
      large:      data.filter(s => s.kennel_type === 'large'  && s.kennel_status === 'assigned').length,
      medium:     data.filter(s => s.kennel_type === 'medium' && s.kennel_status === 'assigned').length,
      small:      data.filter(s => s.kennel_type === 'small'  && s.kennel_status === 'assigned').length,
      unassigned: data.filter(s => s.kennel_status === 'unassigned').length,
      needsSize:  data.filter(s => s.kennel_status === 'needs_size').length,
    };

    // Live, real-time snapshot of physical kennel capacity (not affected by from/to)
    const kennelOccupancy = await getKennelOccupancySummary(getDateStringInTZ(new Date()));

    // Bookings broken down by program type (boarding, basic, bundle, etc.)
    const serviceBreakdown = {};
    data.forEach(s => { serviceBreakdown[s.service_type] = (serviceBreakdown[s.service_type] || 0) + 1; });

    res.json({ totals, kennelBreakdown, kennelOccupancy, serviceBreakdown, stays: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH — confirm a requested stay (portal → GHL)
app.patch('/api/stays/:id/confirm', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: stay, error } = await supabase
      .from('boarding_stays').select('*').eq('id', id).single();
    if (error || !stay) return res.status(404).json({ error: 'Stay not found' });

    // Update both GHL appointments
    const promises = [];
    if (stay.ghl_dropoff_appointment_id) {
      promises.push(updateAppointment(stay.ghl_dropoff_appointment_id, { appointmentStatus: 'confirmed' }));
    }
    if (stay.ghl_pickup_appointment_id) {
      promises.push(updateAppointment(stay.ghl_pickup_appointment_id, { appointmentStatus: 'confirmed' }));
    }
    await Promise.all(promises);

    await supabase.from('boarding_stays').update({
      status: 'confirmed',
      last_modified_source: 'portal',
      last_synced_at: new Date().toISOString(),
    }).eq('id', id);

    await logSync({ stayId: id, direction: 'db_to_ghl', action: 'confirmed', payload: { id }, status: 'success' });
    res.json({ success: true });
  } catch (err) {
    await logSync({ stayId: req.params.id, direction: 'db_to_ghl', action: 'confirmed', payload: {}, status: 'failed', errorMessage: err.message });
    res.status(500).json({ error: err.message });
  }
});

// PATCH — reschedule a stay (portal → GHL)
app.patch('/api/stays/:id/reschedule', async (req, res) => {
  try {
    const { id } = req.params;
    const { start_date, end_date } = req.body;

    const { data: stay, error } = await supabase
      .from('boarding_stays').select('*').eq('id', id).single();
    if (error || !stay) return res.status(404).json({ error: 'Stay not found' });

    const promises = [];
    if (start_date && stay.ghl_dropoff_appointment_id) {
      promises.push(updateAppointment(stay.ghl_dropoff_appointment_id, { startTime: start_date }));
    }
    if (end_date && stay.ghl_pickup_appointment_id) {
      promises.push(updateAppointment(stay.ghl_pickup_appointment_id, { startTime: end_date }));
    }
    await Promise.all(promises);

    const dbUpdate = { last_modified_source: 'portal', last_synced_at: new Date().toISOString() };
    if (start_date) dbUpdate.start_date = start_date;
    if (end_date)   dbUpdate.end_date   = end_date;

    await supabase.from('boarding_stays').update(dbUpdate).eq('id', id);
    // Dates changed — the previously-assigned kennel may now conflict
    // with something else, or a kennel may have freed up. Re-check.
    await assignKennelAndSave(id).catch(err => console.error('Kennel assignment error:', err.message));
    await logSync({ stayId: id, direction: 'db_to_ghl', action: 'rescheduled', payload: req.body, status: 'success' });
    res.json({ success: true });
  } catch (err) {
    await logSync({ stayId: req.params.id, direction: 'db_to_ghl', action: 'rescheduled', payload: req.body, status: 'failed', errorMessage: err.message });
    res.status(500).json({ error: err.message });
  }
});

// PATCH — cancel a stay (portal → GHL)
app.patch('/api/stays/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: stay, error } = await supabase
      .from('boarding_stays').select('*').eq('id', id).single();
    if (error || !stay) return res.status(404).json({ error: 'Stay not found' });

    const promises = [];
    if (stay.ghl_dropoff_appointment_id) {
      promises.push(updateAppointment(stay.ghl_dropoff_appointment_id, { appointmentStatus: 'cancelled' }));
    }
    if (stay.ghl_pickup_appointment_id) {
      promises.push(updateAppointment(stay.ghl_pickup_appointment_id, { appointmentStatus: 'cancelled' }));
    }
    await Promise.all(promises);

    await supabase.from('boarding_stays').update({
      status: 'cancelled',
      last_modified_source: 'portal',
      last_synced_at: new Date().toISOString(),
    }).eq('id', id);

    await logSync({ stayId: id, direction: 'db_to_ghl', action: 'cancelled', payload: { id }, status: 'success' });
    res.json({ success: true });
  } catch (err) {
    await logSync({ stayId: req.params.id, direction: 'db_to_ghl', action: 'cancelled', payload: {}, status: 'failed', errorMessage: err.message });
    res.status(500).json({ error: err.message });
  }
});

// PATCH — update internal notes (portal only, no GHL sync)
app.patch('/api/stays/:id/notes', async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    await supabase.from('boarding_stays').update({ internal_notes: notes }).eq('id', id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET sync log for a stay
app.get('/api/stays/:id/log', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sync_log').select('*')
      .eq('stay_id', req.params.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET failed syncs
app.get('/api/sync/failed', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sync_log').select('*, boarding_stays(owner_name, dog_name)')
      .in('status', ['failed', 'pending_retry'])
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------
// AUTH — email + PIN login, with lockout after repeated failures
// Matches against the portal_users table seeded via migration
// ------------------------------------------------------------
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, pin } = req.body;
    if (!email || !pin) return res.status(400).json({ error: 'Email and PIN required' });

    const { data, error } = await supabase
      .from('portal_users')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .eq('is_active', true)
      .limit(1);

    if (error || !data || data.length === 0) {
      return res.status(401).json({ error: 'No active account found for this email' });
    }

    const user = data[0];

    // Check lockout
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minsLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(423).json({ error: `Account locked. Try again in ${minsLeft} minute(s).` });
    }

    const pinMatches = await bcrypt.compare(String(pin), user.pin_hash || '');

    if (!pinMatches) {
      const newFailedAttempts = (user.failed_attempts || 0) + 1;
      const updatePayload = { failed_attempts: newFailedAttempts };

      if (newFailedAttempts >= MAX_FAILED_ATTEMPTS) {
        const lockUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60000);
        updatePayload.locked_until = lockUntil.toISOString();
      }

      await supabase.from('portal_users').update(updatePayload).eq('id', user.id);

      const remaining = Math.max(0, MAX_FAILED_ATTEMPTS - newFailedAttempts);
      return res.status(401).json({
        error: newFailedAttempts >= MAX_FAILED_ATTEMPTS
          ? `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.`
          : `Incorrect PIN. ${remaining} attempt(s) remaining.`,
      });
    }

    // Success — reset failed attempts, update last login
    await supabase.from('portal_users').update({
      failed_attempts: 0,
      locked_until: null,
      last_login_at: new Date().toISOString(),
    }).eq('id', user.id);

    res.json({
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ------------------------------------------------------------
// START
// ------------------------------------------------------------
app.listen(CONFIG.PORT, () => {
  console.log(`Dogs Spot Sync Backend running on port ${CONFIG.PORT}`);
  console.log(`Webhook endpoint: POST /webhook/ghl`);
  console.log(`API base: GET/PATCH /api/stays`);
  if (!CONFIG.WEBHOOK_SECRET) {
    console.warn('⚠ WEBHOOK_SECRET is not set — /webhook/ghl will accept requests from ANYONE who finds the URL. Set WEBHOOK_SECRET in your .env and add it to the GHL webhook config.');
  }
});
