// ============================================================
// The Dogs Spot — GHL Sync Backend
// Node.js / Express — deploy to Render or Railway (free tier)
// ============================================================
// Setup:
//   npm install express @supabase/supabase-js axios dotenv bcryptjs
//   node server.js
// ============================================================

require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// Serves anything placed in /public — put boarding-booking.html here
// so it's reachable at https://<your-render-url>/boarding-booking.html
// with zero extra hosting to set up.
app.use(express.static('public'));

// ------------------------------------------------------------
// AUTH LOCKOUT CONSTANTS
// (previously referenced in /api/auth/login but never defined —
// this is what was causing every failed PIN attempt to 500)
// ------------------------------------------------------------
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

// ------------------------------------------------------------
// DATE RANGE / TIMEZONE HELPERS
// (previously referenced by findAvailableKennel and the kennel/
// dashboard routes but never defined — this is what was causing
// "rangesOverlap is not defined" on every kennel assignment)
// ------------------------------------------------------------
const BUSINESS_TZ = 'America/New_York';

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  const aE = aEnd || '9999-12-31';
  const bE = bEnd || '9999-12-31';
  return aStart <= bE && bStart <= aE;
}

function getDateStringInTZ(date, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

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

  // Window in hours within which two appointments are considered part of the same booking
  PAIRING_WINDOW_HOURS: 2,

  // KENNEL INVENTORY — fixed physical capacity
  KENNEL_COUNTS: { regular: 20, special_needs: 10, small: 10 },

  // Custom field(s) on the GHL contact that store the dog's kennel size
  KENNEL_SIZE_FIELD_IDS: ['MNwzpEaxKwgifkOsvhIb', '9m5zqCls4pQFTdlJJZaI'],
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
// CONTACT WEBHOOK DETECTION
// ------------------------------------------------------------
function isContactWebhook(body, query = {}) {
  const type = body.type || body.eventType || body.event || body.eventName;
  if (type && /contact/i.test(type)) return true;

  const hasAppointmentSignal =
    (body.calendar && body.calendar.appointmentId) ||
    body.appointmentId || body.appointment_id ||
    body.calendarId || body.calendar_id ||
    query.appointment_id || query.appointmentId ||
    query.calendar_id || query.calendarId;
  if (hasAppointmentSignal) return false;

  const hasContactIdentity =
    body.contact_id || body.contactId || body.contact?.id || query.contact_id || query.contactId ||
    body.email || body.phone ||
    body.first_name || body.firstName;
  return Boolean(hasContactIdentity);
}

// ------------------------------------------------------------
// PHONE NORMALISATION
// ------------------------------------------------------------
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

// ------------------------------------------------------------
// PAIRING GROUPS
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
  return PAIRING_GROUPS[serviceType] || serviceType; 
}
function serviceTypesInGroup(serviceType) {
  const group = pairingGroupOf(serviceType);
  return Object.keys(PAIRING_GROUPS).filter(st => PAIRING_GROUPS[st] === group);
}

// ------------------------------------------------------------
// NAME RESOLUTION
// ------------------------------------------------------------
function resolveOwnerName(contact) {
  if (!contact) return null;

  const fullNameCandidates = [
    contact.name, contact.fullName, contact.full_name, contact.contactName,
    contact.contact?.name, contact.contact?.fullName, contact.contact?.full_name
  ];
  for (const candidate of fullNameCandidates) {
    if (candidate && String(candidate).trim()) return String(candidate).trim();
  }

  const first = contact.firstName || contact.first_name || contact.firstname || contact.contact?.firstName || contact.contact?.first_name || '';
  const last  = contact.lastName  || contact.last_name  || contact.lastname  || contact.contact?.lastName  || contact.contact?.last_name || '';
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

// Creates a real GHL appointment directly — used by the multi-dog
// booking endpoint so the dog's name is set with certainty at
// creation time, instead of being inferred later from a webhook.
async function createAppointment({ calendarId, contactId, title, startTime, endTime, appointmentStatus }) {
  const res = await ghl.post('/calendars/events/appointments', {
    calendarId,
    locationId: CONFIG.GHL_LOCATION,
    contactId,
    title,
    startTime,
    endTime,
    appointmentStatus: appointmentStatus || 'confirmed',
  });
  // GHL wraps the created record differently across API versions —
  // handle both `{ id, ... }` and `{ appointment: { id, ... } } shapes.
  return res.data?.appointment || res.data;
}

// Finds the contact by email/phone, or creates one, in a single call.
async function upsertContact({ email, phone, firstName, lastName }) {
  const res = await ghl.post('/contacts/upsert', {
    locationId: CONFIG.GHL_LOCATION,
    email: email || undefined,
    phone: phone || undefined,
    firstName: firstName || undefined,
    lastName: lastName || undefined,
  });
  return res.data?.contact || res.data;
}

// Simple type-ahead contact search for staff — matches by name, email,
// or phone against GHL's basic query search.
async function searchContacts(query) {
  const res = await ghl.get('/contacts/', {
    params: { locationId: CONFIG.GHL_LOCATION, query, limit: 10 },
  });
  const contacts = res.data?.contacts || [];
  return contacts.map(c => ({
    id: c.id,
    name: c.contactName || c.name || [c.firstName, c.lastName].filter(Boolean).join(' '),
    firstName: c.firstName || '',
    lastName: c.lastName || '',
    email: c.email || '',
    phone: c.phone || '',
  }));
}

async function getContactAppointments(contactId) {
  if (!contactId || contactId === 'LIVE_WEBHOOK_MATCH' || contactId === 'PENDING_POST_SYNC') return [];
  const now = new Date();
  const searchStart = now.getTime() - 90 * 24 * 60 * 60 * 1000;
  const searchEnd = now.getTime() + 90 * 24 * 60 * 60 * 1000;
  const res = await ghl.get(`/calendars/events?locationId=${CONFIG.GHL_LOCATION}&contactId=${contactId}&startTime=${searchStart}&endTime=${searchEnd}`);
  return res.data?.events || res.data?.appointments || [];
}

// ------------------------------------------------------------
// AIRTIGHT CUSTOM FIELD VALUE EXTRACTOR
// ------------------------------------------------------------
function getCustomFieldValue(payload, fieldIds, namedKeys) {
  if (!payload) return null;

  if (namedKeys) {
    for (const key of namedKeys) {
      if (payload[key] && String(payload[key]).trim()) return String(payload[key]).trim();
      if (payload.contact?.[key] && String(payload.contact[key]).trim()) return String(payload.contact[key]).trim();
    }
  }

  if (fieldIds) {
    for (const id of fieldIds) {
      if (payload[id] && String(payload[id]).trim()) return String(payload[id]).trim();
      if (payload.contact?.[id] && String(payload.contact[id]).trim()) return String(payload.contact[id]).trim();
    }
  }

  const checkFields = (target) => {
    if (!target) return null;
    const cFields = target.customFields || target.customField || target.custom_fields;
    if (!cFields) return null;
    const ids = fieldIds || [];
    if (Array.isArray(cFields)) {
      for (const id of ids) {
        const entry = cFields.find(f => f && (f.id === id || f.fieldId === id));
        const val = entry?.value || entry?.fieldValue;
        if (val && String(val).trim()) return String(val).trim();
      }
    } else if (typeof cFields === 'object') {
      for (const id of ids) {
        if (cFields[id] && String(cFields[id]).trim()) return String(cFields[id]).trim();
      }
    }
    return null;
  };

  return checkFields(payload) || checkFields(payload.contact);
}

const DOG_NAME_FIELD_IDS = ['MNwzpEaxKwgifkOsvhIb', '9m5zqCls4pQFTdlJJZaI'];

function resolveDogName(contact) {
  return getCustomFieldValue(contact, DOG_NAME_FIELD_IDS, ["Dog's Name", "dogs_name", "dog_name"]);
}

// ------------------------------------------------------------
// DOG NAME FROM APPOINTMENT TITLE
// If the calendar's "Meeting Invite Title" is set to a merge-field
// template like "{{contact.active_booking_dog_name}} — Boarding Drop
// Off", the rendered title text becomes a permanent, per-appointment
// snapshot of the dog's name at the moment that specific appointment
// was created — unlike a live contact field, which can get
// overwritten by a later booking for a different dog on the same
// contact. This is the PREFERRED source when available; expects the
// dog name to appear before a " - " / " – " / " — " separator.
// ------------------------------------------------------------
const TITLE_STATIC_LABELS = new Set([
  'boarding drop off', 'boarding pick up', 'basic drop off', 'basic pick-up',
  'leash free drop off', 'leash free pick up', 'service dog drop off', 'service dog pick-up',
  'community drop off', 'community pick-up', 'bundle drop off', 'bundle pick-up',
]);

function resolveDogNameFromTitle(title) {
  if (!title) return null;
  const parts = String(title).split(/\s[-\u2013\u2014]\s/); // splits on " - ", " – ", " — "
  if (parts.length < 2) return null;
  const candidate = parts[0].trim();
  if (!candidate || TITLE_STATIC_LABELS.has(candidate.toLowerCase())) return null;
  return candidate;
}

// ------------------------------------------------------------
// AUTOMATIC KENNEL CATEGORY SPLITTER & PARSER
// ------------------------------------------------------------
const KENNEL_CATEGORY_MAP = {
  'special need - graduated':    { kennel_type: 'special_needs', kennel_grad_status: 'graduated' },
  'special needs - graduated':   { kennel_type: 'special_needs', kennel_grad_status: 'graduated' },
  'special need - non graduate': { kennel_type: 'special_needs', kennel_grad_status: 'non_graduate' },
  'special need - non-graduate': { kennel_type: 'special_needs', kennel_grad_status: 'non_graduate' },
  'special needs - non graduate':{ kennel_type: 'special_needs', kennel_grad_status: 'non_graduate' },
  'special needs - non-graduate':{ kennel_type: 'special_needs', kennel_grad_status: 'non_graduate' },
  'special need - in process':   { kennel_type: 'special_needs', kennel_grad_status: 'in_process'   },
  'special need - in-process':   { kennel_type: 'special_needs', kennel_grad_status: 'in_process'   },
  'special needs - in process':  { kennel_type: 'special_needs', kennel_grad_status: 'in_process'   },
  'special needs - in-process':  { kennel_type: 'special_needs', kennel_grad_status: 'in_process'   },
  'special need':                { kennel_type: 'special_needs', kennel_grad_status: null            },
  'special needs':               { kennel_type: 'special_needs', kennel_grad_status: null            },
  'regular - graduated':         { kennel_type: 'regular',       kennel_grad_status: 'graduated'    },
  'regular - non graduate':      { kennel_type: 'regular',       kennel_grad_status: 'non_graduate' },
  'regular - non-graduate':      { kennel_type: 'regular',       kennel_grad_status: 'non_graduate' },
  'regular - in process':        { kennel_type: 'regular',       kennel_grad_status: 'in_process'   },
  'regular - in-process':        { kennel_type: 'regular',       kennel_grad_status: 'in_process'   },
  'regular':                     { kennel_type: 'regular',       kennel_grad_status: null            },
  'small - graduated':           { kennel_type: 'small',         kennel_grad_status: 'graduated'    },
  'small - non graduate':        { kennel_type: 'small',         kennel_grad_status: 'non_graduate' },
  'small - non-graduate':        { kennel_type: 'small',         kennel_grad_status: 'non_graduate' },
  'small - in process':          { kennel_type: 'small',         kennel_grad_status: 'in_process'   },
  'small - in-process':          { kennel_type: 'small',         kennel_grad_status: 'in_process'   },
  'small':                       { kennel_type: 'small',         kennel_grad_status: null            },
};

// Parses a kennel category label into { kennel_type, kennel_grad_status }.
// Deliberately format-agnostic: your dropdown options mix styles —
// some use a dash ("Small - Graduated"), others don't and include a
// price ("Regular Boarding Graduate $30 per day"). Rather than relying
// on a separator, this just looks for the relevant keywords anywhere
// in the string, so both styles (and any price/day suffix) parse the
// same way.
function parseKennelCategoryText(raw) {
  if (!raw) return null;
  const normalized = String(raw).toLowerCase();

  let kennel_type = 'regular';
  if (normalized.includes('special')) {
    kennel_type = 'special_needs';
  } else if (normalized.includes('small')) {
    kennel_type = 'small';
  } else if (normalized.includes('overflow')) {
    kennel_type = 'overflow';
  } else if (normalized.includes('regular')) {
    kennel_type = 'regular';
  }

  // Check "non-graduate" before generic "graduate" — it's a substring
  // of it, so order matters here.
  let kennel_grad_status = null;
  if (normalized.includes('non-graduate') || normalized.includes('non graduate') || normalized.includes('nongraduate') || normalized.includes('non-grad')) {
    kennel_grad_status = 'non_graduate';
  } else if (normalized.includes('in process') || normalized.includes('in-process')) {
    kennel_grad_status = 'in_process';
  } else if (normalized.includes('graduate') || normalized.includes('graduated')) {
    kennel_grad_status = 'graduated';
  }

  return { kennel_type, kennel_grad_status };
}

function resolveKennelCategory(contact, flatPayload) {
  try {
    let raw = getCustomFieldValue(flatPayload, CONFIG.KENNEL_SIZE_FIELD_IDS, ['Kennel Category', 'kennel_category', 'kennel category']);
    if (!raw) {
      raw = getCustomFieldValue(contact, CONFIG.KENNEL_SIZE_FIELD_IDS, ['Kennel Category', 'kennel_category', 'kennel category']);
    }
    return parseKennelCategoryText(raw);
  } catch (err) {
    console.error("Error within resolveKennelCategory parser:", err.message);
    return null;
  }
}

function resolveKennelType(contact, flatPayload) {
  return resolveKennelCategory(contact, flatPayload)?.kennel_type || null;
}

async function isReturningClient(contactId) {
  const { data: stays, error: sErr } = await supabase
    .from('boarding_stays')
    .select('id')
    .eq('contact_id', contactId)
    .in('status', ['completed', 'active', 'confirmed'])
    .limit(1);

  if (sErr || !stays) return false;
  return stays.length > 0;
}

// ------------------------------------------------------------
// DETERMINE STATUS
// ------------------------------------------------------------
async function determineStatus(source, contactId) {
  if (source === 'internal') return 'confirmed';
  const returning = await isReturningClient(contactId);
  return returning ? 'confirmed' : 'requested';
}

async function getContact(contactId) {
  const res = await ghl.get(`/contacts/${contactId}`);
  return res.data?.contact || null;
}

// ------------------------------------------------------------
// PAIRING ENGINE 
// ------------------------------------------------------------
const BOARDING_PAIRING_WINDOW_HOURS = 24;

async function findPairableStay(identity, appointmentBookedAt, role, serviceType) {
  const { contactId, phone, email, dogName } = identity;
  const group = pairingGroupOf(serviceType);

  const missingField = role === 'dropoff' ? 'ghl_dropoff_appointment_id' : 'ghl_pickup_appointment_id';
  const normPhone = normalizePhone(phone);
  const normEmail = email ? String(email).trim().toLowerCase() : null;

  let query = supabase
    .from('boarding_stays')
    .select('*')
    .eq('status', 'incomplete')
    .in('service_type', serviceTypesInGroup(serviceType))
    .is(missingField, null);

  let orConditions = [];
  if (contactId && contactId !== 'LIVE_WEBHOOK_MATCH') orConditions.push(`contact_id.eq.${contactId}`);
  if (normEmail) orConditions.push(`owner_email.ilike.${normEmail}`);
  if (normPhone) orConditions.push(`owner_phone.ilike.%${normPhone}%`);

  if (orConditions.length > 0) {
    query = query.or(orConditions.join(','));
  } else {
    return null;
  }

  const { data, error } = await query;
  if (error || !data || data.length === 0) return null;

  let candidates = data.filter(row => {
    if (contactId && row.contact_id === contactId) return true;
    if (normPhone && normalizePhone(row.owner_phone) === normPhone) return true;
    if (normEmail && row.owner_email && String(row.owner_email).trim().toLowerCase() === normEmail) return true;
    return false;
  });

  if (candidates.length === 0) return null;

  // ------------------------------------------------------------
  // DOG-LEVEL DISAMBIGUATION
  // A single contact can have more than one dog boarding at once —
  // matching purely on contact/phone/email would risk pairing Dog A's
  // dropoff with Dog B's pickup when both share an owner and land in
  // the same time window. When we know the incoming dog's name, we
  // narrow the candidate pool to stays that either (a) already carry
  // the same dog name, or (b) don't have a dog name recorded yet
  // (safe to pair — most likely this same dog's other leg, just not
  // yet confirmed). Candidates known to belong to a *different* named
  // dog are excluded outright rather than risking a wrong merge.
  // ------------------------------------------------------------
  if (dogName && candidates.length > 1) {
    const norm = s => String(s).trim().toLowerCase();
    const sameNamed = candidates.filter(c => c.dog_name && norm(c.dog_name) === norm(dogName));
    const unnamed   = candidates.filter(c => !c.dog_name);
    candidates = sameNamed.length ? sameNamed : unnamed;
    if (candidates.length === 0) return null; // every remaining candidate belongs to a different, known dog
  }

  if (group === 'boarding') {
    const targetTime = new Date(appointmentBookedAt).getTime();
    let bestMatch = null;
    let minDiff = Infinity;

    for (const cand of candidates) {
      if (!cand.ghl_date_added) continue;
      const candTime = new Date(cand.ghl_date_added).getTime();
      const diff = Math.abs(candTime - targetTime);

      if (diff <= BOARDING_PAIRING_WINDOW_HOURS * 3600 * 1000 && diff < minDiff) {
        minDiff = diff;
        bestMatch = cand;
      }
    }
    return bestMatch;
  } else {
    candidates.sort((a, b) => {
      const timeA = a.ghl_date_added ? new Date(a.ghl_date_added).getTime() : Infinity;
      const timeB = b.ghl_date_added ? new Date(b.ghl_date_added).getTime() : Infinity;
      return timeA - timeB;
    });
    return candidates[0];
  }
}

async function findStaysForContact({ contactId, phone, email }) {
  const normPhone = normalizePhone(phone);
  const normEmail = email ? String(email).trim().toLowerCase() : null;
  if (!normPhone && !normEmail && !contactId) return [];

  const { data, error } = await supabase.from('boarding_stays').select('*');
  if (error || !data) return [];

  return data.filter(row => {
    if (contactId && row.contact_id === contactId) return true;
    if (normPhone && normalizePhone(row.owner_phone) === normPhone) return true;
    if (normEmail && row.owner_email && String(row.owner_email).trim().toLowerCase() === normEmail) return true;
    return false;
  });
}

// ------------------------------------------------------------
// PROCESS CONTACT PROFILE UPDATES
// ------------------------------------------------------------
// Per-dog kennel category custom fields, set on the CONTACT (used
// for first-time clients: staff assigns these after intake, once per
// dog, since the client didn't know their dog's category at booking
// time). Position 1/2/3 is matched to whichever of the contact's
// currently-open stays was created first/second/third — since our
// booking flow creates dog 1's stay before dog 2's before dog 3's,
// sorting by creation time recovers the same order these fields were
// filled in.
const PER_DOG_KENNEL_CATEGORY_KEYS = [
  ['kennel_category'],    // dog 1
  ['kennel_category_2'],  // dog 2
  ['kennel_category_3'],  // dog 3
];

function resolvePerDogKennelCategory(flatPayload, dogIndex) {
  const raw = getCustomFieldValue(flatPayload, null, PER_DOG_KENNEL_CATEGORY_KEYS[dogIndex]);
  if (!raw) return null;
  return parseKennelCategoryText(raw);
}

async function processContactUpdate({ contactId, phone, email, ownerName, _flatContact }) {
  const dogName = resolveDogName(_flatContact);

  const stays = await findStaysForContact({ contactId, phone, email });
  if (stays.length === 0) {
    console.log(`Contact update for ${contactId}: no linked stays found, nothing to sync`);
    return;
  }

  // Shared fields apply to every stay on this contact.
  const sharedUpdate = {};
  if (ownerName) sharedUpdate.owner_name  = ownerName;
  if (email)     sharedUpdate.owner_email = email;
  if (phone)     sharedUpdate.owner_phone = phone;

  // Order the contact's open stays the same way they were created
  // (dog 1 first), so per-dog fields line up with the right stay.
  const openStays = [...stays]
    .filter(s => !['cancelled', 'completed'].includes(s.status))
    .sort((a, b) => {
      const ta = a.ghl_date_added ? new Date(a.ghl_date_added).getTime() : 0;
      const tb = b.ghl_date_added ? new Date(b.ghl_date_added).getTime() : 0;
      return ta - tb;
    });

  let syncedCount = 0;

  for (let i = 0; i < openStays.length; i++) {
    const stay = openStays[i];
    const stayUpdate = { ...sharedUpdate };

    if (openStays.length === 1) {
      // Only one dog on this contact — no ambiguity, accept either the
      // dog-1 slot or the single legacy "Dog's Name"/"Kennel Category" field.
      if (dogName && !stay.dog_name) stayUpdate.dog_name = dogName;
      const cat = resolvePerDogKennelCategory(_flatContact, 0) || resolveKennelCategory(null, _flatContact);
      if (cat) {
        stayUpdate.kennel_type       = cat.kennel_type;
        stayUpdate.graduation_status = cat.kennel_grad_status;
        stayUpdate.kennel_id         = null;
        stayUpdate.kennel_status     = 'unassigned';
      }
    } else {
      // Multiple dogs on this contact — only apply the category field
      // that matches THIS dog's position, never all three at once.
      const cat = resolvePerDogKennelCategory(_flatContact, i);
      if (cat) {
        stayUpdate.kennel_type       = cat.kennel_type;
        stayUpdate.graduation_status = cat.kennel_grad_status;
        stayUpdate.kennel_id         = null;
        stayUpdate.kennel_status     = 'unassigned';
      }
    }

    if (Object.keys(stayUpdate).length === 0) continue;

    stayUpdate.last_modified_source = 'ghl';
    stayUpdate.last_synced_at = new Date().toISOString();

    await supabase.from('boarding_stays').update(stayUpdate).eq('id', stay.id);
    if (['incomplete', 'confirmed', 'requested', 'active'].includes(stay.status)) {
      await assignKennelAndSave(stay.id).catch(err => console.error('Kennel assignment error:', err.message));
    }
    await logSync({ stayId: stay.id, ghlAppointmentId: null, direction: 'ghl_to_db', action: 'contact_updated', payload: _flatContact });
    syncedCount++;
  }

  console.log(`Contact update for ${contactId}: synced ${syncedCount} of ${openStays.length} open stay(s)`);
}

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
// KENNEL ASSIGNMENT ENGINE (FULLY RESTORED & ALIGNED)
// ------------------------------------------------------------
async function getAllKennels() {
  const { data, error } = await supabase.from('kennels').select('*').eq('active', true).order('label');
  if (error) throw error;
  return data || [];
}

async function findAvailableKennel(kennelType, startDate, endDate, excludeStayId) {
  if (!startDate || !endDate) return null; 
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

async function computeKennelAssignment(stay) {
  if (!stay.start_date || !stay.end_date) {
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

  const summary = {
    special_needs: { total: 0, filled: 0 },
    regular:       { total: 0, filled: 0 },
    small:         { total: 0, filled: 0 },
    overflow:      { total: 0, filled: 0 },
  };
  kennels.forEach(k => {
    if (!summary[k.type]) summary[k.type] = { total: 0, filled: 0 };
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
// DASHBOARD BUILDER FOR A GIVEN DATE
// (previously referenced by /api/dashboard/today but never
// defined — this is what was causing that route to 500)
// ------------------------------------------------------------
async function buildDashboardForDate(dateStr) {
  const target = dateStr || getDateStringInTZ(new Date());

  const { data: stays, error } = await supabase.from('boarding_stays').select('*');
  if (error) throw error;

  const notCancelled = (stays || []).filter(s => s.status !== 'cancelled');
  const arriving  = notCancelled.filter(s => s.start_date === target);
  const departing = notCancelled.filter(s => s.end_date === target);
  const active = notCancelled.filter(s => {
    if (!s.start_date || s.start_date > target) return false;
    if (!s.end_date) return true;
    return s.end_date >= target;
  });
  const pending    = (stays || []).filter(s => s.status === 'requested');
  const incomplete = (stays || []).filter(s => s.status === 'incomplete');

  const kennelOccupancy = await getKennelOccupancySummary(target);

  return {
    date: target,
    counts: {
      arriving:  arriving.length,
      departing: departing.length,
      active:    active.length,
      total:     (stays || []).length,
      pending:   pending.length,
      incomplete: incomplete.length,
    },
    arriving,
    departing,
    active,
    kennelOccupancy,
  };
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
    _flatContact,
  } = payload;

  const calMeta = CALENDAR_LOOKUP[calendarId];
  if (!calMeta) {
    console.log(`Ignoring appointment from unrecognized calendar: ${calendarId}`);
    return;
  }

  const { serviceType, role, source } = calMeta;

  // Dynamic Concurrency Guard Stagger Lock
  if (role === 'pickup') {
    console.log(`[Concurrency Lock] Staggering pickup webhook for 2 seconds to allow dropoff to write first...`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  const prefilled = _flatContact ? {
    name:  _flatContact.full_name || _flatContact.contact?.fullName || [_flatContact.first_name || _flatContact.contact?.firstName, _flatContact.last_name || _flatContact.contact?.lastName].filter(Boolean).join(' ') || null,
    email: _flatContact.email || _flatContact.contact?.email || null,
    phone: _flatContact.phone || _flatContact.contact?.phone || null,
  } : null;

  const existingField = role === 'dropoff' ? 'ghl_dropoff_appointment_id' : 'ghl_pickup_appointment_id';
  const cleanStartTime = startTime ? new Date(startTime).toISOString() : null;
  const cleanEndTime = endTime ? new Date(endTime).toISOString() : null;
  const appointmentBookedAt = dateAdded ? new Date(dateAdded).toISOString() : new Date().toISOString();
  
  const { data: existingStays } = await supabase
    .from('boarding_stays')
    .select('*')
    .eq(existingField, ghlAppointmentId)
    .limit(1);

  if (existingStays && existingStays.length > 0) {
    const stay = existingStays[0];
    const contactLookup = (!stay.dog_name || !stay.kennel_type) ? await getContact(contactId).catch(() => null) : null;
    const dogName = resolveDogNameFromTitle(payload.title) || resolveDogName(_flatContact) || resolveDogName(contactLookup);
    const kennelCat = resolveKennelCategory(contactLookup, _flatContact);

    const updatePayload = {
      [role === 'dropoff' ? 'start_date' : 'end_date']: role === 'dropoff' ? cleanStartTime : cleanEndTime,
      ghl_date_added: appointmentBookedAt,
      last_modified_source: 'ghl',
      last_synced_at: new Date().toISOString(),
    };

    if (!stay.dog_name && dogName) updatePayload.dog_name = dogName;
    if (!stay.kennel_type && kennelCat) {
      updatePayload.kennel_type = kennelCat.kennel_type;
      updatePayload.graduation_status = kennelCat.kennel_grad_status; 
    }
    if (ghlStatus === 'cancelled') updatePayload.status = 'cancelled';

    await supabase.from('boarding_stays').update(updatePayload).eq('id', stay.id);
    if (updatePayload.status !== 'cancelled') await assignKennelAndSave(stay.id).catch(err => console.error('Kennel assignment error:', err.message));
    await logSync({ stayId: stay.id, ghlAppointmentId, direction: 'ghl_to_db', action: eventType === 'AppointmentCreate' ? 'created' : 'updated', payload });
    console.log(`Updated stay ${stay.id} from GHL (${role})`);
    return;
  }

  const needsContactLookup = !prefilled || !prefilled.phone || !prefilled.email || !resolveDogName(_flatContact);
  const contact = needsContactLookup ? await getContact(contactId).catch(() => null) : null;
  const ownerPhone = prefilled?.phone || contact?.phone || null;
  const ownerEmail = prefilled?.email || contact?.email || null;

  // Prefer the dog name straight off THIS webhook's flat payload —
  // that's a snapshot of what was submitted for THIS specific
  // appointment. Falling back to a live contact lookup is riskier for
  // multi-dog households, since "Dog's Name" is a single field on the
  // contact and can get overwritten by whichever booking the client
  // submitted most recently.
  const incomingDogName = resolveDogNameFromTitle(payload.title) || resolveDogName(_flatContact) || resolveDogName(contact);

  const pairableStay = await findPairableStay(
    { contactId, phone: ownerPhone, email: ownerEmail, dogName: incomingDogName },
    appointmentBookedAt,
    role,
    serviceType
  );

  if (pairableStay) {
    const status  = await determineStatus(source, contactId);

    const updatePayload = {
      [existingField]: ghlAppointmentId,
      [role === 'dropoff' ? 'dropoff_calendar_id' : 'pickup_calendar_id']: calendarId,
      [role === 'dropoff' ? 'start_date' : 'end_date']: role === 'dropoff' ? cleanStartTime : cleanEndTime,
      source,
      service_type: role === 'dropoff' ? serviceType : pairableStay.service_type,
      status: pairableStay.status === 'incomplete' ? status : pairableStay.status,
      is_returning_client: status === 'confirmed' && source === 'online',
      last_modified_source: 'ghl',
      last_synced_at: new Date().toISOString(),
      owner_name:  pairableStay.owner_name  || prefilled?.name  || resolveOwnerName(contact),
      owner_email: pairableStay.owner_email || ownerEmail,
      owner_phone: pairableStay.owner_phone || ownerPhone,
      dog_name:    pairableStay.dog_name    || incomingDogName,
      ghl_date_added: pairableStay.ghl_date_added || appointmentBookedAt,
      ...(() => {
        const cat = resolveKennelCategory(contact, payload) ||
                    (pairableStay.kennel_type ? { kennel_type: pairableStay.kennel_type, graduation_status: pairableStay.graduation_status } : null);
        return cat ? { kennel_type: cat.kennel_type, graduation_status: cat.kennel_grad_status } : {};
      })(),
    };

    await supabase.from('boarding_stays').update(updatePayload).eq('id', pairableStay.id);
    await assignKennelAndSave(pairableStay.id).catch(err => console.error('Kennel assignment error:', err.message));
    await logSync({ stayId: pairableStay.id, ghlAppointmentId, direction: 'ghl_to_db', action: 'paired', payload });
    console.log(`Paired ${role} appointment into stay ${pairableStay.id}`);
  } else {
    const insertPayload = {
      contact_id:   contactId,
      owner_name:   prefilled?.name  || resolveOwnerName(contact),
      owner_email:  ownerEmail,
      owner_phone:  ownerPhone,
      dog_name:     incomingDogName,
      source,
      service_type: serviceType,
      status: 'incomplete',
      last_modified_source: 'ghl',
      last_synced_at: new Date().toISOString(),
      ghl_date_added: appointmentBookedAt,
      ...(() => {
        const cat = resolveKennelCategory(contact, payload);
        return cat ? { kennel_type: cat.kennel_type, graduation_status: cat.kennel_grad_status } : {};
      })(),
      kennel_status: 'needs_size',
      [existingField]: ghlAppointmentId,
      [role === 'dropoff' ? 'dropoff_calendar_id' : 'pickup_calendar_id']: calendarId,
      [role === 'dropoff' ? 'start_date' : 'end_date']: role === 'dropoff' ? cleanStartTime : cleanEndTime,
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

async function processCancellation(payload) {
  const { id: ghlAppointmentId } = payload;

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
// AUTOMATED TIMELINE HEALING ENGINE (THE AUTO-RETRY LOOP)
// ------------------------------------------------------------
const MAX_STAY_DAYS = 90; 

async function autoHealTimelineQueue() {
  try {
    const { data: incompleteStays } = await supabase
      .from('boarding_stays')
      .select('*')
      .eq('status', 'incomplete')
      .neq('contact_id', 'LIVE_WEBHOOK_MATCH');

    if (!incompleteStays || incompleteStays.length === 0) return;

    for (const stay of incompleteStays) {
      if (!stay || !stay.contact_id || stay.contact_id === 'PENDING_POST_SYNC') continue;
      
      const ghlAppts = await getContactAppointments(stay.contact_id);
      if (!ghlAppts || ghlAppts.length === 0) continue;

      const missingRole = stay.ghl_dropoff_appointment_id ? 'pickup' : 'dropoff';
      const existingApptTime = new Date(stay.start_date || stay.end_date).getTime();

      const matchingLeg = ghlAppts.find(appt => {
        if (!appt || !appt.calendarId) return false;
        const apptStartTime = appt.startTime || appt.start_time;
        if (!apptStartTime) return false;

        const calMeta = CALENDAR_LOOKUP[appt.calendarId];
        if (!calMeta || calMeta.role !== missingRole) return false;

        const apptTime = new Date(apptStartTime).getTime();
        const delta = Math.abs(apptTime - existingApptTime);

        if (delta > MAX_STAY_DAYS * 24 * 3600 * 1000) return false;
        if (missingRole === 'pickup' && apptTime < existingApptTime) return false;
        if (missingRole === 'dropoff' && apptTime > existingApptTime) return false;

        return true;
      });

      if (matchingLeg && (matchingLeg.id || matchingLeg.appointmentId)) {
        console.log(`[Timeline Healer] Found missing ${missingRole} leg for ${stay.owner_name}. Unifying stay...`);
        
        const isDropoff = missingRole === 'dropoff';
        const targetCalId = matchingLeg.calendarId;
        const source = CALENDAR_LOOKUP[targetCalId]?.source || 'internal';
        const status = await determineStatus(source, stay.contact_id);
        const cleanLegTime = new Date(matchingLeg.startTime || matchingLeg.start_time).toISOString();

        const updatePayload = {
          [isDropoff ? 'ghl_dropoff_appointment_id' : 'ghl_pickup_appointment_id']: matchingLeg.id || matchingLeg.appointmentId,
          [isDropoff ? 'dropoff_calendar_id' : 'pickup_calendar_id']: targetCalId,
          [isDropoff ? 'start_date' : 'end_date']: cleanLegTime,
          status,
          last_modified_source: 'ghl',
          last_synced_at: new Date().toISOString()
        };

        await supabase.from('boarding_stays').update(updatePayload).eq('id', stay.id);
        await assignKennelAndSave(stay.id).catch(() => null);
        await logSync({ stayId: stay.id, ghlAppointmentId: matchingLeg.id || matchingLeg.appointmentId, direction: 'ghl_to_db', action: 'auto_healed_timeline', payload: matchingLeg });
      }
    }
  } catch (err) {
    console.error('[Timeline Healer Error]:', err.message);
  }
}

setInterval(autoHealTimelineQueue, 60000);

// ------------------------------------------------------------
// WEBHOOK ENDPOINT (GHL → DB)
// ------------------------------------------------------------
app.post('/webhook/ghl', async (req, res) => {
  if (CONFIG.WEBHOOK_SECRET) {
    const providedSecret = req.query.secret || req.headers['x-webhook-secret'];
    if (providedSecret !== CONFIG.WEBHOOK_SECRET) {
      console.warn('Rejected webhook: missing or invalid secret');
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }
  }

  res.status(200).json({ received: true });
  console.log('RAW WEBHOOK BODY:', JSON.stringify(req.body, null, 2));

  const body = req.body;
  const query = req.query || {}; 

  if (isContactWebhook(body, query)) {
    const contactId  = body.contact_id || body.contactId || body.contact?.id || body.contact?.contact_id || body.id;
    const phone       = body.phone || body.contact?.phone;
    const email       = body.email || body.contact?.email;
    const ownerName   = body.full_name || body.fullName || body.contact?.fullName || body.contact?.full_name ||
      [body.first_name || body.firstName || body.contact?.firstName, body.last_name || body.lastName || body.contact?.lastName].filter(Boolean).join(' ') || null;

    console.log(`Contact webhook received — contactId: ${contactId}`);

    try {
      await processContactUpdate({ contactId, phone, email, ownerName, _flatContact: body });
    } catch (err) {
      console.error('Webhook processing error for ContactUpdate:', err.message);
      await logSync({
        ghlAppointmentId: null,
        direction: 'ghl_to_db',
        action: 'contact_updated',
        payload: body,
        status: 'failed',
        errorMessage: err.message,
      });
    }
    return;
  }

  let type, payload;

  if (body.calendar && body.calendar.appointmentId) {
    const cal = body.calendar;
    const apptStatus = (cal.appoinmentStatus || cal.appointmentStatus || cal.status || '').toLowerCase();
    type = apptStatus === 'cancelled' ? 'AppointmentDelete' : 'AppointmentCreate';

    payload = {
      id:         cal.appointmentId,
      calendarId: cal.id,
      startTime:  cal.startTime,
      endTime:    cal.endTime,
      status:     apptStatus,
      dateAdded:  cal.date_created || body.date_created,
      title:      cal.title,
      contactId:  body.contact_id || body.contactId || body.contact?.id || body.id, 
      ownerName:  body.full_name || [body.first_name || body.contact?.firstName, body.last_name || body.contact?.lastName].filter(Boolean).join(' '),
      ownerEmail: body.email || body.contact?.email,
      ownerPhone: body.phone || body.contact?.phone,
      _flatContact: body,
    };

    console.log(`Workflow webhook → normalised as ${type} — appointmentId: ${payload.id} calendarId: ${payload.calendarId}`);
  } else {
    const apptStatus = (body.status || body.appointmentStatus || query.status || 'confirmed').toLowerCase();
    const rawType = body.type || body.eventType || body.event || body.eventName;
    type = (rawType === 'AppointmentDelete' || apptStatus === 'cancelled') ? 'AppointmentDelete' : 'AppointmentCreate';
    
    const appointmentId = body.id || body.appointmentId || body.appointment_id || query.appointment_id || query.appointmentId;

    payload = {
      ...body,
      id:         appointmentId,
      contactId:  body.contactId  || body.contact_id || body.contact?.id || query.contact_id || query.contactId || body.id, 
      calendarId: body.calendarId || body.calendar_id || query.calendar_id || query.calendarId,
      startTime:  body.startTime  || body.start_time  || query.start_time  || query.startTime,
      endTime:    body.endTime    || body.end_time    || query.end_time    || query.endTime,
      status:     apptStatus,
      dateAdded:  body.dateAdded  || body.date_added  || body.createdAt || new Date().toISOString(),
      title:      body.title || body.appointmentTitle || body.calendar?.title || null,
      _flatContact: body,
    };

    console.log(`Standard/Workflow URL webhook normalized: ${type} — appointmentId: ${appointmentId} calendarId: ${payload.calendarId}`);
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
// ------------------------------------------------------------

app.get('/api/stays', async (req, res) => {
  try {
    const { status, source, serviceType, from, to, search, kennelType, kennelStatus } = req.query;
    let query = supabase.from('boarding_stays').select('*').order('start_date', { ascending: true });

    if (status)       query = query.eq('status', status);
    if (source)       query = query.eq('source', source);
    if (serviceType)  query = query.eq('service_type', serviceType);
    if (kennelType)   query = query.eq('kennel_type', kennelType);
    if (kennelStatus) query = query.eq('kennel_status', kennelStatus);
    if (from)         query = query.gte('start_date', from);
    if (to)           query = query.lte('start_date', to);
    if (search)       query = query.or(`owner_name.ilike.%${search}%,dog_name.ilike.%${search}%`);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/today', async (req, res) => {
  try {
    const { date } = req.query;
    const payload = await buildDashboardForDate(date || null);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/kennels', async (req, res) => {
  try {
    const kennels = await getAllKennels();
    res.json(kennels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/kennels/occupancy', async (req, res) => {
  try {
    const dateStr = req.query.date || getDateStringInTZ(new Date());
    const payload = await getKennelOccupancySummary(dateStr);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/stays/:id/kennel', async (req, res) => {
  try {
    const { id } = req.params;
    const { kennel_id } = req.body;
    const { data: stay, error } = await supabase.from('boarding_stays').select('*').eq('id', id).single();
    if (error || !stay) return res.status(404).json({ error: 'Stay not found' });

    if (kennel_id) {
      const { data: kennel, error: kErr } = await supabase.from('kennels').select('*').eq('id', kennel_id).single();
      if (kErr || !kennel) return res.status(404).json({ error: 'Kennel not found' });

      const available = await findAvailableKennel(kennel.type, stay.start_date, stay.end_date, stay.id);
      if (!available || available.id !== kennel_id) {
        console.warn(`Manual kennel assignment: ${kennel_id} for stay ${id} overlaps another stay's dates — proceeding anyway.`);
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

// ------------------------------------------------------------
// KENNEL SETTINGS (counts per category)
// Previously referenced by the frontend's "Kennel Settings" page
// but no backend route existed for it at all.
// ------------------------------------------------------------
const KENNEL_SETTINGS_TYPES = ['special_needs', 'regular', 'small', 'overflow'];
const KENNEL_LABEL_PREFIX = { special_needs: 'SN', regular: 'R', small: 'S', overflow: 'OF' };

app.get('/api/kennels/settings', async (req, res) => {
  try {
    const kennels = await getAllKennels();
    const counts = {};
    KENNEL_SETTINGS_TYPES.forEach(t => { counts[t] = 0; });
    kennels.forEach(k => { counts[k.type] = (counts[k.type] || 0) + 1; });
    res.json({ counts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// body: { type: 'special_needs'|'regular'|'small'|'overflow', target: <int> }
app.post('/api/kennels/settings', async (req, res) => {
  try {
    const { type, target } = req.body;
    if (!KENNEL_SETTINGS_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid kennel type' });
    const targetCount = parseInt(target, 10);
    if (!Number.isFinite(targetCount) || targetCount < 0) return res.status(400).json({ error: 'Invalid target count' });

    const kennels = (await getAllKennels()).filter(k => k.type === type);
    const currentCount = kennels.length;

    if (targetCount === currentCount) {
      return res.json({ type, before: currentCount, after: currentCount, added: 0, removed: 0, blocked: 0 });
    }

    if (targetCount > currentCount) {
      const toAdd = targetCount - currentCount;
      const existingNums = kennels
        .map(k => parseInt(String(k.label).replace(/\D/g, ''), 10))
        .filter(n => Number.isFinite(n));
      let nextNum = existingNums.length ? Math.max(...existingNums) + 1 : 1;

      const inserts = [];
      for (let i = 0; i < toAdd; i++) {
        inserts.push({ label: `${KENNEL_LABEL_PREFIX[type]}-${String(nextNum).padStart(2, '0')}`, type, active: true });
        nextNum++;
      }
      const { error } = await supabase.from('kennels').insert(inserts);
      if (error) throw error;
      return res.json({ type, before: currentCount, after: targetCount, added: toAdd, removed: 0, blocked: 0 });
    }

    // Shrinking: never remove a kennel with an active/upcoming stay.
    const toRemove = currentCount - targetCount;
    const today = getDateStringInTZ(new Date());

    const { data: liveStays, error: sErr } = await supabase
      .from('boarding_stays')
      .select('kennel_id, end_date, status')
      .not('kennel_id', 'is', null)
      .not('status', 'in', '(cancelled,completed)');
    if (sErr) throw sErr;

    const occupiedKennelIds = new Set(
      liveStays.filter(s => !s.end_date || s.end_date >= today).map(s => s.kennel_id)
    );

    const removable = kennels.filter(k => !occupiedKennelIds.has(k.id));
    const idsToRemove = removable.slice(0, toRemove).map(k => k.id);
    const blocked = toRemove - idsToRemove.length;

    if (idsToRemove.length) {
      const { error: dErr } = await supabase.from('kennels').delete().in('id', idsToRemove);
      if (dErr) throw dErr;
    }

    res.json({
      type,
      before: currentCount,
      after: currentCount - idsToRemove.length,
      added: 0,
      removed: idsToRemove.length,
      blocked, // still above target — these kennels currently have active/upcoming stays
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------
// PUBLIC MULTI-DOG BOARDING BOOKING ENDPOINT
// Replaces the survey's single "name of all dogs" free-text field +
// single calendar visit. The client submits ALL their dogs and one
// shared drop-off/pick-up date range in ONE request; this endpoint
// creates a real, separate GHL appointment pair per dog (with the
// dog's name written directly into the title, not inferred) and
// writes the matching boarding_stays row for each dog in the same
// request — so there is no pairing ambiguity for these bookings at
// all, unlike appointments that arrive via GHL's own calendar widget.
//
// Body: {
//   firstName, lastName, email, phone,
//   hasBoardedBefore: boolean,
//   dogs: [{ name: string }],   // 1-3 dogs
//   startDate: 'YYYY-MM-DD',    // shared drop-off date across all dogs
//   endDate:   'YYYY-MM-DD',    // shared pick-up date across all dogs
// }
// ------------------------------------------------------------
app.post('/api/bookings/boarding', async (req, res) => {
  try {
    const { firstName, lastName, email, phone, hasBoardedBefore, dogs, startDate, endDate } = req.body;

    if (!email && !phone) return res.status(400).json({ error: 'Email or phone is required' });
    if (!Array.isArray(dogs) || dogs.length === 0 || dogs.length > 3) {
      return res.status(400).json({ error: 'Provide between 1 and 3 dogs' });
    }
    if (!startDate || !endDate) return res.status(400).json({ error: 'Drop-off and pick-up dates are required' });

    const cleanDogs = dogs
      .map(d => (typeof d === 'string'
        ? { name: d, goodWithOtherDogs: null, kennelType: null, graduationStatus: null }
        : { name: d?.name, goodWithOtherDogs: d?.goodWithOtherDogs ?? null, kennelType: d?.kennelType || null, graduationStatus: d?.graduationStatus || null }))
      .map(d => ({ ...d, name: (d.name || '').trim() }))
      .filter(d => d.name);
    if (cleanDogs.length === 0) return res.status(400).json({ error: 'At least one dog name is required' });

    const contact = await upsertContact({ email, phone, firstName, lastName });
    if (!contact || !contact.id) throw new Error('Could not find or create GHL contact');
    const contactId = contact.id;

    const cals = CONFIG.CALENDARS.boarding;
    const startIso = new Date(startDate + 'T09:00:00').toISOString();
    const endIso   = new Date(endDate   + 'T09:00:00').toISOString();
    const source = 'online';

    // The self-reported "have you boarded before" answer is what
    // actually drives this — per the existing GHL workflow, first-time
    // clients' appointments go in as "new" so staff can vet them before
    // confirming (their dog's temperament, etc.); returning clients go
    // straight to "confirmed". This is a direct business rule from the
    // survey answer, not a guess from booking history.
    const isFirstTime = !hasBoardedBefore;
    const ghlAppointmentStatus = isFirstTime ? 'new' : 'confirmed';
    const status = isFirstTime ? 'requested' : 'confirmed';

    const created = [];
    const errors = [];

    for (const dog of cleanDogs) {
      const dogName = dog.name;
      try {
        const dropoff = await createAppointment({
          calendarId: cals.DROPOFF_ONLINE,
          contactId,
          title: `${dogName} — Boarding Drop Off`,
          startTime: startIso,
          endTime: startIso,
          appointmentStatus: ghlAppointmentStatus,
        });
        const pickup = await createAppointment({
          calendarId: cals.PICKUP_ONLINE,
          contactId,
          title: `${dogName} — Boarding Pick Up`,
          startTime: endIso,
          endTime: endIso,
          appointmentStatus: ghlAppointmentStatus,
        });

        const notesParts = [];
        if (isFirstTime && dog.goodWithOtherDogs !== null && dog.goodWithOtherDogs !== undefined) {
          notesParts.push(`Good with other dogs: ${dog.goodWithOtherDogs ? 'Yes' : 'No'}`);
        }

        const insertPayload = {
          contact_id: contactId,
          owner_name: [firstName, lastName].filter(Boolean).join(' ') || null,
          owner_email: email || null,
          owner_phone: phone || null,
          dog_name: dogName,
          source,
          service_type: 'boarding',
          status,
          is_returning_client: !!hasBoardedBefore,
          internal_notes: notesParts.join(' · ') || null,
          last_modified_source: 'portal',
          last_synced_at: new Date().toISOString(),
          ghl_date_added: new Date().toISOString(),
          ghl_dropoff_appointment_id: dropoff.id,
          ghl_pickup_appointment_id: pickup.id,
          dropoff_calendar_id: cals.DROPOFF_ONLINE,
          pickup_calendar_id: cals.PICKUP_ONLINE,
          start_date: startIso,
          end_date: endIso,
          // Returning clients tell us their dog's category right in
          // this form, so we skip the "needs_size" flag entirely for
          // them; first-timers still land as needs_size until staff
          // set kennel_category (or _2/_3) on the contact after intake.
          ...(dog.kennelType ? { kennel_type: dog.kennelType, graduation_status: dog.graduationStatus, kennel_status: 'unassigned' } : { kennel_status: 'needs_size' }),
        };

        const { data: newStay, error: insertErr } = await supabase
          .from('boarding_stays')
          .insert(insertPayload)
          .select()
          .single();
        if (insertErr) throw insertErr;

        const kennelResult = await assignKennelAndSave(newStay.id).catch(() => null);
        await logSync({ stayId: newStay.id, ghlAppointmentId: dropoff.id, direction: 'db_to_ghl', action: 'created_via_multi_dog_booking', payload: { dogName, startDate, endDate }, status: 'success' });

        created.push({ dogName, stayId: newStay.id, kennelStatus: kennelResult?.kennel_status || 'needs_size' });
      } catch (err) {
        console.error(`Multi-dog booking failed for dog "${dogName}":`, err.message);
        errors.push({ dogName, error: err.message });
      }
    }

    res.json({ contactId, created, errors, success: errors.length === 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------
// CONTACT SEARCH (staff-facing type-ahead)
// ------------------------------------------------------------
app.get('/api/contacts/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const matches = await searchContacts(q);
    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------
// INTERNAL (STAFF-FACING) MULTI-DOG BOOKING ENDPOINT
// Same shape as /api/bookings/boarding, but for staff creating
// bookings on a client's behalf from the portal — supports any
// service type (using IN-PERSON calendars, since staff booked this
// directly rather than the client booking online), staff already
// knows the kennel type/graduation per dog (no "needs_size" flagging
// unless staff deliberately leaves it blank), and always goes in as
// "confirmed" since staff has already vetted the client.
//
// Body: {
//   contactId?: string,                  // if selected from search
//   firstName, lastName, email, phone,   // used if contactId not given (or to fill gaps)
//   serviceType: 'boarding'|'basic'|'bundle'|'leash_free'|'service_dog'|'community',
//   dogs: [{ name, kennelType?, graduationStatus? }],  // 1-3 dogs
//   startDate, endDate,
// }
// ------------------------------------------------------------
app.post('/api/bookings/internal', async (req, res) => {
  try {
    const { contactId: existingContactId, firstName, lastName, email, phone, serviceType, dogs, startDate, endDate } = req.body;

    if (!CONFIG.CALENDARS[serviceType]) return res.status(400).json({ error: 'Unknown service type' });
    if (!existingContactId && !email && !phone) return res.status(400).json({ error: 'Select a contact or provide an email/phone' });
    if (!Array.isArray(dogs) || dogs.length === 0 || dogs.length > 3) {
      return res.status(400).json({ error: 'Provide between 1 and 3 dogs' });
    }
    if (!startDate || !endDate) return res.status(400).json({ error: 'Drop-off and pick-up dates are required' });

    const cleanDogs = dogs
      .map(d => ({ name: (d?.name || '').trim(), kennelType: d?.kennelType || null, graduationStatus: d?.graduationStatus || null }))
      .filter(d => d.name);
    if (cleanDogs.length === 0) return res.status(400).json({ error: 'At least one dog name is required' });

    const contactId = existingContactId || (await upsertContact({ email, phone, firstName, lastName }))?.id;
    if (!contactId) throw new Error('Could not find or create GHL contact');

    const cals = CONFIG.CALENDARS[serviceType];
    if (!cals.DROPOFF_INPERSON || !cals.PICKUP_INPERSON) {
      return res.status(400).json({ error: `No in-person calendars configured for ${serviceType}` });
    }
    const startIso = new Date(startDate + 'T09:00:00').toISOString();
    const endIso   = new Date(endDate   + 'T09:00:00').toISOString();

    const created = [];
    const errors = [];

    for (const dog of cleanDogs) {
      const dogName = dog.name;
      try {
        const dropoff = await createAppointment({
          calendarId: cals.DROPOFF_INPERSON,
          contactId,
          title: `${dogName} — ${serviceType === 'boarding' ? 'Boarding' : serviceType} Drop Off`,
          startTime: startIso,
          endTime: startIso,
          appointmentStatus: 'confirmed',
        });
        const pickup = await createAppointment({
          calendarId: cals.PICKUP_INPERSON,
          contactId,
          title: `${dogName} — ${serviceType === 'boarding' ? 'Boarding' : serviceType} Pick Up`,
          startTime: endIso,
          endTime: endIso,
          appointmentStatus: 'confirmed',
        });

        const insertPayload = {
          contact_id: contactId,
          owner_name: [firstName, lastName].filter(Boolean).join(' ') || null,
          owner_email: email || null,
          owner_phone: phone || null,
          dog_name: dogName,
          source: 'internal',
          service_type: serviceType,
          status: 'confirmed',
          is_returning_client: true,
          last_modified_source: 'portal',
          last_synced_at: new Date().toISOString(),
          ghl_date_added: new Date().toISOString(),
          ghl_dropoff_appointment_id: dropoff.id,
          ghl_pickup_appointment_id: pickup.id,
          dropoff_calendar_id: cals.DROPOFF_INPERSON,
          pickup_calendar_id: cals.PICKUP_INPERSON,
          start_date: startIso,
          end_date: endIso,
          ...(dog.kennelType ? { kennel_type: dog.kennelType, graduation_status: dog.graduationStatus, kennel_status: 'unassigned' } : { kennel_status: 'needs_size' }),
        };

        const { data: newStay, error: insertErr } = await supabase
          .from('boarding_stays')
          .insert(insertPayload)
          .select()
          .single();
        if (insertErr) throw insertErr;

        const kennelResult = await assignKennelAndSave(newStay.id).catch(() => null);
        await logSync({ stayId: newStay.id, ghlAppointmentId: dropoff.id, direction: 'db_to_ghl', action: 'created_via_internal_booking', payload: { dogName, serviceType, startDate, endDate }, status: 'success' });

        created.push({ dogName, stayId: newStay.id, kennelStatus: kennelResult?.kennel_status || 'needs_size' });
      } catch (err) {
        console.error(`Internal booking failed for dog "${dogName}":`, err.message);
        errors.push({ dogName, error: err.message });
      }
    }

    res.json({ contactId, created, errors, success: errors.length === 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

    const kennelBreakdown = {
      special_needs: data.filter(s => s.kennel_type === 'special_needs' && s.kennel_status === 'assigned').length,
      regular:       data.filter(s => s.kennel_type === 'regular'       && s.kennel_status === 'assigned').length,
      small:         data.filter(s => s.kennel_type === 'small'         && s.kennel_status === 'assigned').length,
      overflow:      data.filter(s => s.kennel_type === 'overflow'      && s.kennel_status === 'assigned').length,
      unassigned:    data.filter(s => s.kennel_status === 'unassigned').length,
      needsSize:     data.filter(s => s.kennel_status === 'needs_size').length,
    };

    const kennelOccupancy = await getKennelOccupancySummary(getDateStringInTZ(new Date()));
    const serviceBreakdown = {};
    data.forEach(s => { serviceBreakdown[s.service_type] = (serviceBreakdown[s.service_type] || 0) + 1; });

    res.json({ totals, kennelBreakdown, kennelOccupancy, serviceBreakdown, stays: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/stays/:id/confirm', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: stay, error } = await supabase
      .from('boarding_stays').select('*').eq('id', id).single();
    if (error || !stay) return res.status(404).json({ error: 'Stay not found' });

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

app.patch('/api/stays/:id/reschedule', async (req, res) => {
  try {
    const { id } = req.params;
    const { start_date, end_date } = req.body;

    const { data: stay, error } = await supabase
      .from('boarding_stays').select('*').eq('id', id).single();
    if (!stay) return res.status(404).json({ error: 'Stay not found' });

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
    await assignKennelAndSave(id).catch(err => console.error('Kennel assignment error:', err.message));
    await logSync({ stayId: id, direction: 'db_to_ghl', action: 'rescheduled', payload: req.body, status: 'success' });
    res.json({ success: true });
  } catch (err) {
    await logSync({ stayId: req.params.id, direction: 'db_to_ghl', action: 'rescheduled', payload: req.body, status: 'failed', errorMessage: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/stays/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: stay, error = null } = await supabase
      .from('boarding_stays').select('*').eq('id', id).single();
    if (!stay) return res.status(404).json({ error: 'Stay not found' });

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
});
