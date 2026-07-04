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
    if (Array.isArray(cFields)) {
      for (const id of fieldIds) {
        const entry = cFields.find(f => f && (f.id === id || f.fieldId === id));
        const val = entry?.value || entry?.fieldValue;
        if (val && String(val).trim()) return String(val).trim();
      }
    } else if (typeof cFields === 'object') {
      for (const id of fieldIds) {
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

function resolveKennelCategory(contact, flatPayload) {
  try {
    let raw = getCustomFieldValue(flatPayload, CONFIG.KENNEL_SIZE_FIELD_IDS, ['Kennel Category', 'kennel_category', 'kennel category']);
    if (!raw) {
      raw = getCustomFieldValue(contact, CONFIG.KENNEL_SIZE_FIELD_IDS, ['Kennel Category', 'kennel_category', 'kennel category']);
    }

    if (!raw) return null;
    const key = String(raw).replace(/\s+/g, ' ').trim().toLowerCase();
    return KENNEL_CATEGORY_MAP[key] || null;
  } catch (err) {
    console.error("Error within resolveKennelCategory parser:", err.message);
    return null;
  }
}

function resolveKennelType(contact, flatPayload) {
  return resolveKennelCategory(contact, flatPayload)?.kennel_type || null;
}

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
  const { contactId, phone, email } = identity;
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

  const candidates = data.filter(row => {
    if (contactId && row.contact_id === contactId) return true;
    if (normPhone && normalizePhone(row.owner_phone) === normPhone) return true;
    if (normEmail && row.owner_email && String(row.owner_email).trim().toLowerCase() === normEmail) return true;
    return false;
  });

  if (candidates.length === 0) return null;

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
async function processContactUpdate({ contactId, phone, email, ownerName, _flatContact }) {
  const dogName    = resolveDogName(_flatContact);
  const kennelCat  = resolveKennelCategory(null, _flatContact);

  const stays = await findStaysForContact({ contactId, phone, email });
  if (stays.length === 0) {
    console.log(`Contact update for ${contactId}: no linked stays found, nothing to sync`);
    return;
  }

  const fieldUpdate = {};
  if (ownerName) fieldUpdate.owner_name  = ownerName;
  if (email)     fieldUpdate.owner_email = email;
  if (phone)     fieldUpdate.owner_phone = phone;
  if (dogName)   fieldUpdate.dog_name    = dogName;
  if (kennelCat) {
    fieldUpdate.kennel_type       = kennelCat.kennel_type;
    fieldUpdate.graduation_status = kennelCat.kennel_grad_status;
    fieldUpdate.kennel_id         = null;
    fieldUpdate.kennel_status     = 'unassigned';
  }

  if (Object.keys(fieldUpdate).length === 0) {
    console.log(`Contact update for ${contactId}: no usable fields in payload, nothing to sync`);
    return;
  }

  fieldUpdate.last_modified_source = 'ghl';
  fieldUpdate.last_synced_at = new Date().toISOString();

  for (const stay of stays) {
    await supabase.from('boarding_stays').update(fieldUpdate).eq('id', stay.id);
    if (['incomplete', 'confirmed', 'requested', 'active'].includes(stay.status)) {
      await assignKennelAndSave(stay.id).catch(err => console.error('Kennel assignment error:', err.message));
    }
    await logSync({ stayId: stay.id, ghlAppointmentId: null, direction: 'ghl_to_db', action: 'contact_updated', payload: _flatContact });
  }

  console.log(`Contact update for ${contactId}: synced ${stays.length} stay(s)`);
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
// KENNEL ASSIGNMENT ENGINE
// ------------------------------------------------------------
async function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  if (!aStart || !bStart) return false;
  const tAStart = new Date(aStart).getTime();
  const tAEnd = aEnd ? new Date(aEnd).getTime() : new Date('9999-12-31').getTime();
  const tBStart = new Date(bStart).getTime();
  const tBEnd = bEnd ? new Date(bEnd).getTime() : new Date('9999-12-31').getTime();
  return tAStart <= tBEnd && tBStart <= tAEnd;
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
    const dogName = resolveDogName(_flatContact) || resolveDogName(contactLookup);
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

  const pairableStay = await findPairableStay(
    { contactId, phone: ownerPhone, email: ownerEmail },
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
      dog_name:    pairableStay.dog_name    || resolveDogName(_flatContact) || resolveDogName(contact),
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
      dog_name:     resolveDogName(_flatContact) || resolveDogName(contact),
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

      // FIXED: Restored variable scope configurations completely
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
      large:      data.filter(s => s.kennel_type === 'large'  && s.kennel_status === 'assigned').length,
      medium:     data.filter(s => s.kennel_type === 'medium' && s.kennel_status === 'assigned').length,
      small:      data.filter(s => s.kennel_type === 'small'  && s.kennel_status === 'assigned').length,
      unassigned: data.filter(s => s.kennel_status === 'unassigned').length,
      needsSize:  data.filter(s => s.kennel_status === 'needs_size').length,
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

// ------------------------------------------------------------
// AUTH — email + PIN login, with lockout after repeated failures
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
