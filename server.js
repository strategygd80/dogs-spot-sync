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
      PICKUP_INPERSON:  '1FnbK7pQp1ViZWIzX95R',   // Boarding Pick Up
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
  const customFields = contact.customFields || contact.customField || [];
  if (!Array.isArray(customFields)) return null;

  for (const fieldId of DOG_NAME_FIELD_IDS) {
    const entry = customFields.find(f => f.id === fieldId);
    const value = entry?.value || entry?.fieldValue || null;
    if (value && String(value).trim()) return String(value).trim();
  }
  return null;
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
// Finds an existing incomplete stay for the same contact
// within the pairing window to merge Drop Off + Pick Up
// ------------------------------------------------------------
async function findPairableStay(contactId, appointmentCreatedAt, role, serviceType) {
  const windowStart = new Date(appointmentCreatedAt);
  windowStart.setHours(windowStart.getHours() - CONFIG.PAIRING_WINDOW_HOURS);
  const windowEnd = new Date(appointmentCreatedAt);
  windowEnd.setHours(windowEnd.getHours() + CONFIG.PAIRING_WINDOW_HOURS);

  // Match against every service type in the same pairing group, not just
  // an exact serviceType match. 'boarding' only matches 'boarding'; the
  // other five service types are interchangeable with each other.
  const eligibleTypes = serviceTypesInGroup(serviceType);

  const { data, error } = await supabase
    .from('boarding_stays')
    .select('*')
    .eq('contact_id', contactId)
    .eq('status', 'incomplete')
    .in('service_type', eligibleTypes)
    .gte('created_at', windowStart.toISOString())
    .lte('created_at', windowEnd.toISOString())
    // Only pair if the other half is missing
    .is(role === 'dropoff' ? 'ghl_dropoff_appointment_id' : 'ghl_pickup_appointment_id', null)
    .order('created_at', { ascending: false })
    .limit(1);

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
    title,
  } = payload;

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
      last_modified_source: 'ghl',
      last_synced_at: new Date().toISOString(),
    };

    // If GHL status is cancelled, propagate
    if (ghlStatus === 'cancelled') updatePayload.status = 'cancelled';

    await supabase.from('boarding_stays').update(updatePayload).eq('id', stay.id);
    await logSync({ stayId: stay.id, ghlAppointmentId, direction: 'ghl_to_db', action: eventType === 'AppointmentCreate' ? 'created' : 'updated', payload });
    console.log(`Updated stay ${stay.id} from GHL (${role})`);
    return;
  }

  // NEW appointment — try to pair with existing incomplete stay
  const pairableStay = await findPairableStay(contactId, new Date().toISOString(), role, serviceType);

  if (pairableStay) {
    // PAIR: merge this appointment into existing incomplete stay
    const contact = await getContact(contactId).catch(() => null);
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
      // Fill contact info if missing
      owner_name:  pairableStay.owner_name  || resolveOwnerName(contact),
      owner_email: pairableStay.owner_email || contact?.email || null,
      owner_phone: pairableStay.owner_phone || contact?.phone || null,
      dog_name:    pairableStay.dog_name    || resolveDogName(contact),
    };

    await supabase.from('boarding_stays').update(updatePayload).eq('id', pairableStay.id);
    await logSync({ stayId: pairableStay.id, ghlAppointmentId, direction: 'ghl_to_db', action: 'paired', payload });
    console.log(`Paired ${role} appointment into stay ${pairableStay.id}`);
  } else {
    // CREATE new incomplete stay (first half of pair)
    const contact = await getContact(contactId).catch(() => null);

    const insertPayload = {
      contact_id:   contactId,
      owner_name:   resolveOwnerName(contact),
      owner_email:  contact?.email || null,
      owner_phone:  contact?.phone || null,
      dog_name:     resolveDogName(contact),
      source,
      service_type: serviceType,
      status: 'incomplete',
      last_modified_source: 'ghl',
      last_synced_at: new Date().toISOString(),
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
// ------------------------------------------------------------
app.post('/webhook/ghl', async (req, res) => {
  // Acknowledge immediately so GHL doesn't retry
  res.status(200).json({ received: true });

  const { type, ...payload } = req.body;
  console.log(`Received webhook: ${type}`, payload?.id);

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
    const { status, source, serviceType, from, to, search } = req.query;
    let query = supabase.from('boarding_stays').select('*').order('start_date', { ascending: true });

    if (status)      query = query.eq('status', status);
    if (source)      query = query.eq('source', source);
    if (serviceType) query = query.eq('service_type', serviceType);
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

app.get('/api/dashboard/today', async (req, res) => {
  try {
    const now = new Date();
    const todayStr    = getDateStringInTZ(now);
    const tomorrowStr = getDateStringInTZ(new Date(now.getTime() + 86400000));

    // Pull a window of candidates, then filter precisely in JS using
    // timezone-aware date comparison (Postgres date range queries on
    // raw timestamps would hit the same UTC-boundary bug).
    //
    // IMPORTANT: only exclude 'cancelled' here, not 'incomplete'.
    // A stay can be 'incomplete' (missing its pickup pairing) while
    // still having a real dropoff appointment today — that dog is
    // still arriving and staff still need to see it on the dashboard.
    // 'active' (below) still correctly requires both dates to be set.
    const { data: allStays } = await supabase
      .from('boarding_stays')
      .select('*')
      .neq('status', 'cancelled');

    const arrivals   = (allStays || []).filter(s => s.start_date && getDateStringInTZ(new Date(s.start_date)) === todayStr);
    const departures = (allStays || []).filter(s => s.end_date   && getDateStringInTZ(new Date(s.end_date))   === todayStr);
    const active      = (allStays || []).filter(s => {
      if (!s.start_date || !s.end_date) return false;
      const startStr = getDateStringInTZ(new Date(s.start_date));
      const endStr   = getDateStringInTZ(new Date(s.end_date));
      return startStr <= todayStr && endStr >= todayStr;
    });

    const [pendingRes, incompleteRes] = await Promise.all([
      supabase.from('boarding_stays').select('*').eq('status', 'requested'),
      supabase.from('boarding_stays').select('*').eq('status', 'incomplete'),
    ]);

    res.json({
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
    });
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

    res.json({ totals, stays: data });
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
});
