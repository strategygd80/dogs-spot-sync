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
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

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
  CALENDARS: {
    DROPOFF_INPERSON: 'wS5N8WN4BbzznaLjEg1N',   // Boarding Drop Off
    DROPOFF_ONLINE:   'ZmmjQJszkRMUltfEbumB',    // Boarding Drop Off - Online
    PICKUP_INPERSON:  '1FnbK7pQp1ViZWIzX95R',   // Boarding Pick Up
    PICKUP_ONLINE:    'bN6wWGJa0qKq0QGRg4CC',    // Boarding Pick Up - Online
  },

  // Window in hours within which two appointments are considered part of the same booking
  PAIRING_WINDOW_HOURS: 2,
};

// Derived sets for quick lookup
const DROPOFF_CALENDAR_IDS = new Set([
  CONFIG.CALENDARS.DROPOFF_INPERSON,
  CONFIG.CALENDARS.DROPOFF_ONLINE,
]);
const PICKUP_CALENDAR_IDS = new Set([
  CONFIG.CALENDARS.PICKUP_INPERSON,
  CONFIG.CALENDARS.PICKUP_ONLINE,
]);

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
async function findPairableStay(contactId, appointmentCreatedAt, role) {
  const windowStart = new Date(appointmentCreatedAt);
  windowStart.setHours(windowStart.getHours() - CONFIG.PAIRING_WINDOW_HOURS);
  const windowEnd = new Date(appointmentCreatedAt);
  windowEnd.setHours(windowEnd.getHours() + CONFIG.PAIRING_WINDOW_HOURS);

  const { data, error } = await supabase
    .from('boarding_stays')
    .select('*')
    .eq('contact_id', contactId)
    .eq('status', 'incomplete')
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

  // Determine role of this appointment
  const isDropoff = DROPOFF_CALENDAR_IDS.has(calendarId);
  const isPickup  = PICKUP_CALENDAR_IDS.has(calendarId);

  if (!isDropoff && !isPickup) {
    console.log(`Ignoring appointment from non-boarding calendar: ${calendarId}`);
    return;
  }

  const role   = isDropoff ? 'dropoff' : 'pickup';
  const source = (calendarId === CONFIG.CALENDARS.DROPOFF_ONLINE || calendarId === CONFIG.CALENDARS.PICKUP_ONLINE)
    ? 'online'
    : 'internal';

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
  const pairableStay = await findPairableStay(contactId, new Date().toISOString(), role);

  if (pairableStay) {
    // PAIR: merge this appointment into existing incomplete stay
    const contact = await getContact(contactId).catch(() => null);
    const status  = await determineStatus(source, contactId);

    const updatePayload = {
      [existingField]: ghlAppointmentId,
      [role === 'dropoff' ? 'dropoff_calendar_id' : 'pickup_calendar_id']: calendarId,
      [role === 'dropoff' ? 'start_date' : 'end_date']: role === 'dropoff' ? startTime : endTime,
      source,
      status: pairableStay.status === 'incomplete' ? status : pairableStay.status,
      is_returning_client: status === 'confirmed' && source === 'online',
      last_modified_source: 'ghl',
      last_synced_at: new Date().toISOString(),
      // Fill contact info if missing
      owner_name:  pairableStay.owner_name  || contact?.name  || null,
      owner_email: pairableStay.owner_email || contact?.email || null,
      owner_phone: pairableStay.owner_phone || contact?.phone || null,
    };

    await supabase.from('boarding_stays').update(updatePayload).eq('id', pairableStay.id);
    await logSync({ stayId: pairableStay.id, ghlAppointmentId, direction: 'ghl_to_db', action: 'paired', payload });
    console.log(`Paired ${role} appointment into stay ${pairableStay.id}`);
  } else {
    // CREATE new incomplete stay (first half of pair)
    const contact = await getContact(contactId).catch(() => null);

    const insertPayload = {
      contact_id:   contactId,
      owner_name:   contact?.name  || null,
      owner_email:  contact?.email || null,
      owner_phone:  contact?.phone || null,
      source,
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
    const { status, source, from, to, search } = req.query;
    let query = supabase.from('boarding_stays').select('*').order('start_date', { ascending: true });

    if (status)  query = query.eq('status', status);
    if (source)  query = query.eq('source', source);
    if (from)    query = query.gte('start_date', from);
    if (to)      query = query.lte('start_date', to);
    if (search)  query = query.or(`owner_name.ilike.%${search}%,dog_name.ilike.%${search}%`);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET today's dashboard summary
app.get('/api/dashboard/today', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    const [arrivals, departures, active, pending, incomplete] = await Promise.all([
      supabase.from('boarding_stays').select('*').gte('start_date', today).lt('start_date', tomorrow).not('status', 'in', '("cancelled","incomplete")'),
      supabase.from('boarding_stays').select('*').gte('end_date', today).lt('end_date', tomorrow).not('status', 'in', '("cancelled","incomplete")'),
      supabase.from('boarding_stays').select('*').lte('start_date', new Date().toISOString()).gte('end_date', new Date().toISOString()).not('status', 'in', '("cancelled","incomplete")'),
      supabase.from('boarding_stays').select('*').eq('status', 'requested'),
      supabase.from('boarding_stays').select('*').eq('status', 'incomplete'),
    ]);

    res.json({
      arrivals:   arrivals.data   || [],
      departures: departures.data || [],
      active:     active.data     || [],
      pending:    pending.data    || [],
      incomplete: incomplete.data || [],
      counts: {
        arrivals:   arrivals.data?.length   || 0,
        departures: departures.data?.length || 0,
        active:     active.data?.length     || 0,
        pending:    pending.data?.length    || 0,
        incomplete: incomplete.data?.length || 0,
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
