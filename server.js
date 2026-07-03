// ============================================================
// The Dogs Spot — Pure Live GHL Sync Backend (Fully Featured)
// Node.js / Express — Deploy to Render or Railway
// ============================================================

require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ------------------------------------------------------------
// CORS Config
// ------------------------------------------------------------
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ------------------------------------------------------------
// CONFIGURATION
// ------------------------------------------------------------
const CONFIG = {
  GHL_TOKEN:      process.env.GHL_TOKEN,       
  GHL_LOCATION:   process.env.GHL_LOCATION,    
  SUPABASE_URL:   process.env.SUPABASE_URL,    
  SUPABASE_KEY:   process.env.SUPABASE_KEY,    
  PORT:           process.env.PORT || 3000,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,  
  TIMEZONE:       'America/New_York',

  CALENDARS: {
    boarding: {
      DROPOFF_INPERSON: 'wS5N8WN4BbzznaLjEg1N',   
      DROPOFF_ONLINE:   'ZmmjQJszkRMUltfEbumB',    
      PICKUP_INPERSON:  '1FnbK7pQp1ViZWIzX9SR',   
      PICKUP_ONLINE:    'bN6wWGJa0qKq0QGRg4CC',    
    },
    basic: {
      DROPOFF_INPERSON: '34JtodEqRp3K2wLp0a0y',   
      PICKUP_INPERSON:  'U53Ci7ndlS0NIkAa6vya',   
      DROPOFF_ONLINE:   null,
      PICKUP_ONLINE:    null,
    },
    leash_free: {
      DROPOFF_INPERSON: 'MXqoZqw2t3ewo1Oxja2m',   
      PICKUP_INPERSON:  'QBN6Y6UGIgDufXHz6B2I',    
      DROPOFF_ONLINE:   null,
      PICKUP_ONLINE:    null,
    },
    service_dog: {
      DROPOFF_INPERSON: 'U0sp9FfaU9qOiWp1Upb',     
      PICKUP_INPERSON:  '8rQdqxN39H6Db3Duf5ZX',    
      DROPOFF_ONLINE:   null,
      PICKUP_ONLINE:    null,
    },
    community: {
      DROPOFF_INPERSON: 'WMnuQPTsY8tz3JaxqPPf',    
      PICKUP_INPERSON:  'DN6b9L0gVEwBI80v7Ctk',    
      DROPOFF_ONLINE:   null,
      PICKUP_ONLINE:    null,
    },
    bundle: {
      DROPOFF_INPERSON: 'ZqzoS3ckFZafZcaUKyOM',    
      PICKUP_INPERSON:  '2sAl9Q61WM2WNTqLqcGj',    
      DROPOFF_ONLINE:   null,
      PICKUP_ONLINE:    null,
    },
  },

  BOARDING_PAIRING_WINDOW_HOURS: 24,
  MAX_STAY_DAYS: 90, // Extended 90-day support for long-term programs & bundles
  HEAL_INTERVAL_MS: 60000, 
  KENNEL_SIZE_FIELD_IDS: ['MNwzpEaxKwgifkOsvhIb', '9m5zqCls4pQFTdlJJZaI'], 
};

// Map calendars directly by their unique Alphanumeric API IDs
const CALENDAR_LOOKUP = {};
for (const [serviceType, cals] of Object.entries(CONFIG.CALENDARS)) {
  if (cals.DROPOFF_INPERSON) CALENDAR_LOOKUP[cals.DROPOFF_INPERSON] = { serviceType, role: 'dropoff', source: 'internal' };
  if (cals.DROPOFF_ONLINE)   CALENDAR_LOOKUP[cals.DROPOFF_ONLINE]   = { serviceType, role: 'dropoff', source: 'online' };
  if (cals.PICKUP_INPERSON)  CALENDAR_LOOKUP[cals.PICKUP_INPERSON]  = { serviceType, role: 'pickup',  source: 'internal' };
  if (cals.PICKUP_ONLINE)    CALENDAR_LOOKUP[cals.PICKUP_ONLINE]    = { serviceType, role: 'pickup',  source: 'online' };
}

const PAIRING_GROUPS = {
  boarding:    'boarding',
  basic:       'flexible',
  bundle:      'flexible',
  leash_free:  'flexible',
  service_dog: 'flexible',
  community:   'flexible',
};
function pairingGroupOf(serviceType) { return PAIRING_GROUPS[serviceType] || serviceType; }

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function getDateStringInTZ(date) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFIG.TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return formatter.format(date);
}

function resolveOwnerName(contact) {
  if (!contact) return null;
  const fullNameCandidates = [contact.name, contact.fullName, contact.full_name, contact.contactName];
  for (const candidate of fullNameCandidates) {
    if (candidate && String(candidate).trim()) return String(candidate).trim();
  }
  const first = contact.firstName || contact.first_name || contact.firstname || '';
  const last  = contact.lastName  || contact.last_name  || contact.lastname  || '';
  return [first, last].filter(Boolean).join(' ').trim() || null;
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

async function getContactAppointments(contactId) {
  if (!contactId || contactId === 'LIVE_WEBHOOK_MATCH') return [];
  const res = await ghl.get(`/contacts/${contactId}/appointments`);
  return res.data?.appointments || [];
}

const DOG_NAME_FIELD_IDS = ['MNwzpEaxKwgifkOsvhIb', '9m5zqCls4pQFTdlJJZaI'];
function resolveDogName(contact) {
  if (!contact) return null;
  const flatDog = contact.dogs_name || contact.dog_name;
  if (flatDog && String(flatDog).trim()) return String(flatDog).trim();

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

function resolveKennelCategory(contact, flatPayload) {
  let raw = null;
  if (flatPayload) raw = flatPayload.kennel_category || flatPayload.kennelCategory;
  if (!raw && contact) {
    const customFields = contact.customFields || contact.customField || [];
    if (Array.isArray(customFields)) {
      for (const fieldId of CONFIG.KENNEL_SIZE_FIELD_IDS) {
        const entry = customFields.find(f => f.id === fieldId);
        const val = entry?.value || entry?.fieldValue || null;
        if (val) { raw = val; break; }
      }
    }
  }
  if (!raw) return null;
  return KENNEL_CATEGORY_MAP[String(raw).trim().toLowerCase()] || null;
}

async function getContact(contactId) {
  if (!contactId || contactId === 'LIVE_WEBHOOK_MATCH') return null;
  const res = await ghl.get(`/contacts/${contactId}`);
  return res.data?.contact || null;
}

async function isReturningClient(contactId) {
  if (!contactId || contactId === 'LIVE_WEBHOOK_MATCH') return false;
  const { data, error } = await supabase
    .from('boarding_stays')
    .select('id')
    .eq('contact_id', contactId)
    .in('status', ['completed', 'active', 'confirmed'])
    .limit(1);
  return !error && data.length > 0;
}

async function findPairableStay(identity, appointmentBookedAt, role, serviceType) {
  const { contactId, phone, email } = identity;
  const missingField = role === 'dropoff' ? 'ghl_dropoff_appointment_id' : 'ghl_pickup_appointment_id';
  
  const normPhone = normalizePhone(phone);
  const normEmail = email ? String(email).trim().toLowerCase() : null;

  let query = supabase.from('boarding_stays').select('*').eq('status', 'incomplete').is(missingField, null);
  let orConditions = [];
  if (contactId && contactId !== 'LIVE_WEBHOOK_MATCH') orConditions.push('contact_id.eq.' + contactId);
  if (normEmail) orConditions.push('owner_email.ilike.' + normEmail);
  if (normPhone) orConditions.push('owner_phone.ilike.%' + normPhone + '%');

  if (orConditions.length === 0) return null;
  const { data, error } = await query.or(orConditions.join(','));
  if (error || !data || data.length === 0) return null;

  const candidates = data.filter(row => {
    if (normPhone && normalizePhone(row.owner_phone) === normPhone) return true;
    if (normEmail && row.owner_email && String(row.owner_email).trim().toLowerCase() === normEmail) return true;
    if (contactId && row.contact_id === contactId) return true;
    return false;
  });

  if (candidates.length === 0) return null;

  const targetTime = new Date(appointmentBookedAt).getTime();
  let bestMatch = null;
  let minDiff = Infinity;

  for (const cand of candidates) {
    if (!cand.ghl_date_added) continue;
    const candTime = new Date(cand.ghl_date_added).getTime();
    const diff = Math.abs(candTime - targetTime);

    if (diff <= CONFIG.BOARDING_PAIRING_WINDOW_HOURS * 3600 * 1000 && diff < minDiff) {
      minDiff = diff;
      bestMatch = cand;
    }
  }
  return bestMatch;
}

async function logSync({ stayId, ghlAppointmentId, direction, action, payload, status = 'success', errorMessage = null }) {
  await supabase.from('sync_log').insert({
    stay_id: stayId || null, ghl_appointment_id: ghlAppointmentId || null,
    direction, action, payload, status, error_message: errorMessage,
  });
}

async function getAllKennels() {
  const { data } = await supabase.from('kennels').select('*').eq('active', true);
  return data || [];
}

// Converts all ISO strings to exact Unix millisecond timestamps for accurate availability checking
async function findAvailableKennel(kennelType, startDate, endDate, excludeStayId) {
  if (!startDate || !endDate) return null; 
  const kennels = (await getAllKennels()).filter(k => k.type === kennelType);
  if (!kennels.length) return null;

  const targetStart = new Date(startDate).getTime();
  const targetEnd = new Date(endDate).getTime();

  const { data: occupied } = await supabase
    .from('boarding_stays')
    .select('id, kennel_id, start_date, end_date, status')
    .not('kennel_id', 'is', null);

  const busyKennelIds = new Set(
    (occupied || [])
      .filter(s => s.id !== excludeStayId && !['cancelled', 'completed'].includes(s.status))
      .filter(s => {
        if (!s.start_date || !s.end_date) return false;
        const occStart = new Date(s.start_date).getTime();
        const occEnd = new Date(s.end_date).getTime();
        return occStart <= targetEnd && targetStart <= occEnd;
      })
      .map(s => s.kennel_id)
  );
  return kennels.find(k => !busyKennelIds.has(k.id)) || null;
}

async function assignKennelAndSave(stayId) {
  const { data: stay } = await supabase.from('boarding_stays').select('*').eq('id', stayId).single();
  if (!stay || !stay.start_date || !stay.end_date) return null; 

  let kennelType = stay.kennel_type;
  let kennelGradStatus = stay.kennel_grad_status;

  if (!kennelType && stay.contact_id && stay.contact_id !== 'LIVE_WEBHOOK_MATCH') {
    const contact = await getContact(stay.contact_id).catch(() => null);
    const resolvedCat = resolveKennelCategory(contact, null);
    kennelType = resolvedCat?.kennel_type || 'regular'; 
    kennelGradStatus = resolvedCat?.kennel_grad_status || null;
  }
  
  if (!kennelType) kennelType = 'regular';

  const kennel = await findAvailableKennel(kennelType, stay.start_date, stay.end_date, stay.id);
  const result = kennel 
    ? { kennel_id: kennel.id, kennel_type: kennelType, kennel_grad_status: kennelGradStatus, kennel_status: 'assigned' }
    : { kennel_id: null, kennel_type: kennelType, kennel_grad_status: kennelGradStatus, kennel_status: 'unassigned' };

  await supabase.from('boarding_stays').update(result).eq('id', stayId);
  return result;
}

async function determineStatus(source, contactId) {
  if (source === 'internal') return 'confirmed';
  return (await isReturningClient(contactId)) ? 'confirmed' : 'requested';
}

// ------------------------------------------------------------
// PIPELINE WEBHOOK ENGINE
// ------------------------------------------------------------
async function processAppointment(payload, eventType) {
  const { id: ghlAppointmentId, calendarId, contactId, startTime, endTime, status: ghlStatus, dateAdded, _flatContact } = payload;
  const appointmentBookedAt = dateAdded ? new Date(dateAdded).toISOString() : new Date().toISOString();
  
  let calMeta = CALENDAR_LOOKUP[calendarId];
  if (!calMeta) return;

  const { serviceType, role, source } = calMeta;
  const existingField = role === 'dropoff' ? 'ghl_dropoff_appointment_id' : 'ghl_pickup_appointment_id';
  
  const cleanStartTime = startTime ? new Date(startTime).toISOString() : null;
  const cleanEndTime = endTime ? new Date(endTime).toISOString() : null;

  const { data: existingStays } = await supabase.from('boarding_stays').select('*').eq(existingField, ghlAppointmentId).limit(1);
  if (existingStays && existingStays.length > 0) {
    const stay = existingStays[0];
    const updatePayload = {
      [role === 'dropoff' ? 'start_date' : 'end_date']: role === 'dropoff' ? cleanStartTime : cleanEndTime,
      ghl_date_added: appointmentBookedAt, last_modified_source: 'ghl', last_synced_at: new Date().toISOString(),
    };
    if (ghlStatus === 'cancelled') updatePayload.status = 'cancelled';
    await supabase.from('boarding_stays').update(updatePayload).eq('id', stay.id);
    if (updatePayload.status !== 'cancelled') await assignKennelAndSave(stay.id).catch(() => null);
    return;
  }

  const prefilled = _flatContact ? {
    name: _flatContact.full_name || [_flatContact.first_name, _flatContact.last_name].filter(Boolean).join(' ') || null,
    email: _flatContact.email || null, phone: _flatContact.phone || null,
  } : null;

  const contact = (!prefilled?.phone) ? await getContact(contactId).catch(() => null) : null;
  const ownerPhone = prefilled?.phone || contact?.phone || null;
  const ownerEmail = prefilled?.email || contact?.email || null;

  const pairableStay = await findPairableStay({ contactId, phone: ownerPhone, email: ownerEmail }, appointmentBookedAt, role, serviceType);

  if (pairableStay) {
    const status = await determineStatus(source, contactId);
    const updatePayload = {
      [existingField]: ghlAppointmentId,
      [role === 'dropoff' ? 'dropoff_calendar_id' : 'pickup_calendar_id']: calendarId,
      [role === 'dropoff' ? 'start_date' : 'end_date']: role === 'dropoff' ? cleanStartTime : cleanEndTime,
      source, status: pairableStay.status === 'incomplete' ? status : pairableStay.status,
      last_modified_source: 'ghl', last_synced_at: new Date().toISOString(),
      owner_name: pairableStay.owner_name || prefilled?.name || resolveOwnerName(contact),
      owner_email: pairableStay.owner_email || ownerEmail, owner_phone: pairableStay.owner_phone || ownerPhone,
      dog_name: pairableStay.dog_name || resolveDogName(_flatContact) || resolveDogName(contact),
    };
    if (contactId && contactId !== 'LIVE_WEBHOOK_MATCH') updatePayload.contact_id = contactId;
    
    await supabase.from('boarding_stays').update(updatePayload).eq('id', pairableStay.id);
    await assignKennelAndSave(pairableStay.id).catch(() => null);
    await logSync({ stayId: pairableStay.id, ghlAppointmentId, direction: 'ghl_to_db', action: 'paired', payload });
  } else {
    const insertPayload = {
      contact_id: contactId || 'LIVE_WEBHOOK_MATCH', owner_name: prefilled?.name || resolveOwnerName(contact),
      owner_email: ownerEmail, owner_phone: ownerPhone, dog_name: resolveDogName(_flatContact) || resolveDogName(contact),
      source, service_type: serviceType, status: 'incomplete', last_modified_source: 'ghl', last_synced_at: new Date().toISOString(),
      ghl_date_added: appointmentBookedAt, kennel_status: 'needs_size', [existingField]: ghlAppointmentId,
      [role === 'dropoff' ? 'dropoff_calendar_id' : 'pickup_calendar_id']: calendarId,
      [role === 'dropoff' ? 'start_date' : 'end_date']: role === 'dropoff' ? cleanStartTime : cleanEndTime,
    };
    const { data: newStay } = await supabase.from('boarding_stays').insert(insertPayload).select().single();
    if (newStay) {
      await assignKennelAndSave(newStay.id).catch(() => null);
      await logSync({ stayId: newStay.id, ghlAppointmentId, direction: 'ghl_to_db', action: 'created', payload });
    }
  }
}

// ------------------------------------------------------------
// AUTOMATED TIMELINE HEALING ENGINE (THE AUTO-RETRY LOOP)
// ------------------------------------------------------------
async function autoHealTimelineQueue() {
  try {
    // ENFORCED: Chained filters execute natively off of an explicit select parameters blueprint
    const { data: incompleteStays } = await supabase
      .from('boarding_stays')
      .select('*')
      .eq('status', 'incomplete')
      .neq('contact_id', 'LIVE_WEBHOOK_MATCH');

    if (!incompleteStays || incompleteStays.length === 0) return;

    for (const stay of incompleteStays) {
      const ghlAppts = await getContactAppointments(stay.contact_id);
      if (ghlAppts.length === 0) continue;

      const missingRole = stay.ghl_dropoff_appointment_id ? 'pickup' : 'dropoff';
      const existingApptTime = new Date(stay.start_date || stay.end_date).getTime();

      const matchingLeg = ghlAppts.find(appt => {
        const calMeta = CALENDAR_LOOKUP[appt.calendarId];
        if (!calMeta || calMeta.role !== missingRole) return false;

        const apptTime = new Date(appt.startTime).getTime();
        const delta = Math.abs(apptTime - existingApptTime);

        if (delta > CONFIG.MAX_STAY_DAYS * 24 * 3600 * 1000) return false;
        if (missingRole === 'pickup' && apptTime < existingApptTime) return false;
        if (missingRole === 'dropoff' && apptTime > existingApptTime) return false;

        return true;
      });

      if (matchingLeg) {
        console.log(`[Timeline Healer] Found missing ${missingRole} leg for ${stay.owner_name}. Unifying stay...`);
        
        const isDropoff = missingRole === 'dropoff';
        const status = await determineStatus(stay.source, stay.contact_id);
        const cleanLegTime = matchingLeg.startTime ? new Date(matchingLeg.startTime).toISOString() : null;

        const updatePayload = {
          [isDropoff ? 'ghl_dropoff_appointment_id' : 'ghl_pickup_appointment_id']: matchingLeg.id,
          [isDropoff ? 'dropoff_calendar_id' : 'pickup_calendar_id']: matchingLeg.calendarId,
          [isDropoff ? 'start_date' : 'end_date']: cleanLegTime,
          status,
          last_modified_source: 'ghl',
          last_synced_at: new Date().toISOString()
        };

        await supabase.from('boarding_stays').update(updatePayload).eq('id', stay.id);
        await assignKennelAndSave(stay.id).catch(() => null);
        await logSync({ stayId: stay.id, ghlAppointmentId: matchingLeg.id, direction: 'ghl_to_db', action: 'auto_healed_timeline', payload: matchingLeg });
      }
    }
  } catch (err) {
    console.error('[Timeline Healer Error]:', err.message);
  }
}

setInterval(autoHealTimelineQueue, CONFIG.HEAL_INTERVAL_MS);

// ------------------------------------------------------------
// API WEBHOOK DISPATCH ROUTER (STANDARD GHL EVENT KEYS ONLY)
// ------------------------------------------------------------
app.post('/webhook/ghl', async (req, res) => {
  res.status(200).json({ received: true });
  const body = req.body;

  const type = body.type || body.eventType || body.event || body.eventName;
  if (!type && !body.id && !body.appointmentId) return; 

  const payload = {
    ...body,
    id:         body.id || body.appointmentId || body.appointment_id,
    contactId:  body.contactId || body.contact_id,
    calendarId: body.calendarId || body.calendar_id,
    startTime:  body.startTime || body.start_time,
    endTime:    body.endTime || body.end_time,
    status:     body.status || body.appointmentStatus,
    dateAdded:  body.dateAdded || body.date_added || body.createdAt,
    _flatContact: body,
  };

  try {
    if (type === 'AppointmentDelete' || payload.status === 'cancelled') {
      const targetId = payload.id;
      await supabase.from('boarding_stays').update({ status: 'cancelled', last_modified_source: 'ghl', last_synced_at: new Date().toISOString() })
        .or(`ghl_dropoff_appointment_id.eq.${targetId},ghl_pickup_appointment_id.eq.${targetId}`);
    } else {
      await processAppointment(payload, type);
    }
  } catch (err) {
    await logSync({ ghlAppointmentId: payload.id, direction: 'ghl_to_db', action: 'webhook_error', payload: req.body, status: 'failed', errorMessage: err.message });
  }
});

// ------------------------------------------------------------
// PORTAL DATA LAYER REST APIS 
// ------------------------------------------------------------
app.get('/api/stays', async (req, res) => {
  try {
    const { status, search } = req.query;
    let query = supabase.from('boarding_stays').select('*').order('start_date', { ascending: true });
    if (status) query = query.eq('status', status);
    if (search) query = query.or(`owner_name.ilike.%${search}%,dog_name.ilike.%${search}%`);
    const { data } = await query;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dashboard/today', async (req, res) => {
  try {
    const today = getDateStringInTZ(new Date());
    const { data: stays } = await supabase.from('boarding_stays').select('*').neq('status', 'cancelled');
    const live = stays || [];
    res.json({
      date: today,
      arrivals: live.filter(s => s.start_date && getDateStringInTZ(new Date(s.start_date)) === today),
      departures: live.filter(s => s.end_date && getDateStringInTZ(new Date(s.end_date)) === today),
      active: live.filter(s => s.start_date && getDateStringInTZ(new Date(s.start_date)) <= today && (!s.end_date || getDateStringInTZ(new Date(s.end_date)) >= today)),
      pending: live.filter(s => s.status === 'requested'),
      incomplete: live.filter(s => s.status === 'incomplete'),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/stays/:id/kennel', async (req, res) => {
  try {
    const { kennel_id } = req.body;
    const update = kennel_id 
      ? { kennel_id, kennel_status: 'assigned', last_modified_source: 'portal', last_synced_at: new Date().toISOString() }
      : { kennel_id: null, kennel_status: 'unassigned', last_modified_source: 'portal', last_synced_at: new Date().toISOString() };
    await supabase.from('boarding_stays').update(update).eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, pin } = req.body;
    const { data } = await supabase.from('portal_users').select('*').eq('email', email.toLowerCase().trim()).eq('is_active', true).limit(1);
    if (!data || data.length === 0) return res.status(401).json({ error: 'User account not found' });
    
    const pinMatches = await bcrypt.compare(String(pin), data[0].pin_hash || '');
    if (!pinMatches) return res.status(401).json({ error: 'Incorrect PIN credential code' });
    
    res.json({ id: data[0].id, email: data[0].email, displayName: data[0].display_name, role: data[0].role });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.listen(CONFIG.PORT, () => {
  console.log(`Dogs Spot Sync Backend running on port ${CONFIG.PORT}`);
});
