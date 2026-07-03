// ============================================================
// The Dogs Spot — Safe-Upsert Chronological Timeline Engine
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,
  TIMEZONE: 'America/New_York',
  CUTOFF_DATE: new Date('2026-05-01T00:00:00Z'),
  MAX_STAY_DAYS: 30 
};

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

const CALENDAR_TEXT_LOOKUP = {
  'boarding drop off':          { serviceType: 'boarding',    role: 'dropoff', source: 'internal' },
  'boarding drop off - online': { serviceType: 'boarding',    role: 'dropoff', source: 'online'   },
  'boarding pick up':           { serviceType: 'boarding',    role: 'pickup',  source: 'internal' },
  'boarding pick up - online':  { serviceType: 'boarding',    role: 'pickup',  source: 'online'   },
  'basic drop off':             { serviceType: 'basic',       role: 'dropoff', source: 'internal' },
  'basic pick-up':              { serviceType: 'basic',       role: 'pickup',  source: 'internal' },
  'leash free drop off':        { serviceType: 'leash_free',  role: 'dropoff', source: 'internal' },
  'leash free pick up':         { serviceType: 'leash_free',  role: 'pickup',  source: 'internal' },
  'service dog drop off':       { serviceType: 'service_dog', role: 'dropoff', source: 'internal' },
  'service dog pick-up':        { serviceType: 'service_dog', role: 'pickup',  source: 'internal' },
  'community drop off':         { serviceType: 'community',   role: 'dropoff', source: 'internal' },
  'community pick-up':          { serviceType: 'community',   role: 'pickup',  source: 'internal' },
  'bundle drop off':            { serviceType: 'bundle',      role: 'dropoff', source: 'internal' },
  'bundle pick-up':             { serviceType: 'bundle',      role: 'pickup',  source: 'internal' },
  
  // Bootcamp Pick-up: Marked as 'bootcamp' initially to inherit paired drop-off type dynamically
  'bootcamp pick-up':           { serviceType: 'bootcamp',    role: 'pickup',  source: 'internal' }
};

const PAIRING_GROUPS = {
  boarding:    'boarding',
  basic:       'flexible',
  bundle:      'flexible',
  leash_free:  'flexible',
  service_dog: 'flexible',
  community:   'flexible',
  bootcamp:    'flexible'  
};

function normalizePhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
  if (lines.length === 0) return [];

  const parseLine = (line) => {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim().replace(/^"|"$/g, ''));
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim().replace(/^"|"$/g, ''));
    return result;
  };

  const headers = parseLine(lines[0]);
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseLine(lines[i]);
    if (values.length !== headers.length) continue;

    const row = {};
    headers.forEach((header, idx) => { row[header] = values[idx] || null; });
    records.push(row);
  }
  return records;
}

function getDateStringInTZ(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return formatter.format(date);
}

async function runImport() {
  const csvPath = path.join(__dirname, 'stays.csv');
  if (!fs.existsSync(csvPath)) {
    console.error(`Error: File not found: ${csvPath}`);
    process.exit(1);
  }

  const rawAppointments = parseCSV(csvPath);
  console.log(`Parsed ${rawAppointments.length} raw appointments from file.`);

  const appointments = [];
  let historicalPurgedCount = 0;

  for (const appt of rawAppointments) {
    const outcome = String(appt['Outcome'] || '').toLowerCase();
    const apptDate = new Date(appt['Requested time'] || appt['Date added']);

    if ((outcome === 'cancelled' || outcome === 'invalid') && apptDate < CONFIG.CUTOFF_DATE) {
      historicalPurgedCount++;
      continue;
    }
    appointments.push(appt);
  }

  console.log(`\n🧹 Discarded ${historicalPurgedCount} old canceled/invalid historical entries.`);

  // Chronological Sort by Requested Time (Actual execution timeline)
  appointments.sort((a, b) => new Date(a['Requested time'] || 0) - new Date(b['Requested time'] || 0));

  const stays = [];
  const MAX_STAY_WINDOW_MS = CONFIG.MAX_STAY_DAYS * 24 * 3600 * 1000;
  let discardedUnmatchedCount = 0;

  for (const appt of appointments) {
    const calString = String(appt['Calendar']).trim().toLowerCase();
    const calMeta = CALENDAR_TEXT_LOOKUP[calString];
    if (!calMeta) {
      discardedUnmatchedCount++;
      continue;
    }

    const role = calMeta.role;
    const otherRole = role === 'dropoff' ? 'pickup' : 'dropoff';
    const serviceType = calMeta.serviceType;
    const group = PAIRING_GROUPS[serviceType] || 'flexible';

    const ownerName = appt['Contact name'];
    const ownerEmail = appt['Email'] ? String(appt['Email']).trim().toLowerCase() : '';
    const normPhone = normalizePhone(appt['Phone']);

    const currentApptTimeMs = new Date(appt['Requested time']).getTime();
    let bestMatch = null;

    // Timeline Pair Link Matching Loop
    for (const stay of stays) {
      if (stay[role] || !stay[otherRole] || stay.group !== 'flexible') {
        if (group === 'boarding' && stay.group !== 'boarding') continue;
        if (group !== 'boarding' && stay.group === 'boarding') continue;
      }

      const phoneMatch = normPhone && stay.phone === normPhone;
      const emailMatch = ownerEmail && stay.email === ownerEmail;
      const nameMatch = ownerName && stay.name.toLowerCase() === ownerName.toLowerCase();
      if (!(phoneMatch || emailMatch || nameMatch)) continue;

      const targetLeg = stay[otherRole];
      const targetLegTimeMs = new Date(targetLeg['Requested time']).getTime();
      const timeDelta = Math.abs(currentApptTimeMs - targetLegTimeMs);

      if (timeDelta <= MAX_STAY_WINDOW_MS) {
        if (role === 'pickup' && currentApptTimeMs >= targetLegTimeMs) {
          bestMatch = stay;
          break; 
        }
        if (role === 'dropoff' && currentApptTimeMs <= targetLegTimeMs) {
          bestMatch = stay;
          break;
        }
      }
    }

    if (bestMatch) {
      bestMatch[role] = appt;
      if (role === 'dropoff') {
        bestMatch.serviceType = serviceType;
        bestMatch.group = group;
      }
      if (ownerEmail && !bestMatch.email) bestMatch.email = ownerEmail;
      if (normPhone && !bestMatch.phone) bestMatch.phone = normPhone;
    } else {
      stays.push({
        name: ownerName,
        email: ownerEmail,
        phone: normPhone,
        serviceType,
        group,
        dropoff: role === 'dropoff' ? appt : null,
        pickup:  role === 'pickup' ? appt : null,
      });
    }
  }

  // FIXED: Strict unconditional drop filter for ANY boarding stay missing its pick-up leg
  let orphanedBoardingPurgedCount = 0;
  const filteredStays = stays.filter(stay => {
    if (stay.group === 'boarding' && stay.dropoff && !stay.pickup) {
      orphanedBoardingPurgedCount++;
      return false; // Skips/deletes the stay entirely from the loading sequence
    }
    return true;
  });

  console.log(`🧹 Strictly filtered out ${orphanedBoardingPurgedCount} total orphaned boarding drop-offs missing a pick-up.`);
  console.log(`📊 Processing safe upsert validation for ${filteredStays.length} historical stays...`);

  let inserted = 0; let updated = 0; let errors = 0;

  for (const stay of filteredStays) {
    const { dropoff, pickup } = stay;

    let finalServiceType = stay.serviceType;
    if (finalServiceType === 'bootcamp') finalServiceType = 'basic';

    let status = 'confirmed';
    if (!dropoff || !pickup) status = 'incomplete';
    if (dropoff?.['Outcome'] === 'cancelled' || pickup?.['Outcome'] === 'cancelled') status = 'cancelled';

    const dropoffTimeStr = dropoff ? dropoff['Requested time'] : null;
    const pickupTimeStr = pickup ? pickup['Requested time'] : null;

    const todayStr = getDateStringInTZ(new Date(), CONFIG.TIMEZONE);
    const startStr = dropoffTimeStr ? getDateStringInTZ(new Date(dropoffTimeStr), CONFIG.TIMEZONE) : null;
    const endStr = pickupTimeStr ? getDateStringInTZ(new Date(pickupTimeStr), CONFIG.TIMEZONE) : null;

    if (status === 'confirmed' && startStr && endStr) {
      if (startStr <= todayStr && endStr >= todayStr) status = 'active';
      else if (endStr < todayStr) status = 'completed';
    }

    const dropoffMeta = dropoff ? CALENDAR_TEXT_LOOKUP[String(dropoff['Calendar']).trim().toLowerCase()] : null;
    const pickupMeta  = pickup  ? CALENDAR_TEXT_LOOKUP[String(pickup['Calendar']).trim().toLowerCase()] : null;
    const resolvedSource = (dropoffMeta?.source === 'online' || pickupMeta?.source === 'online') ? 'online' : 'internal';

    const dropoffId = dropoff ? dropoff['Appointment id'] : null;
    const pickupId = pickup ? pickup['Appointment id'] : null;

    const payload = {
      contact_id: 'PENDING_POST_SYNC',
      owner_name: stay.name,
      owner_email: stay.email || null,
      owner_phone: stay.phone || null,
      dog_name: null, 
      start_date: dropoffTimeStr ? new Date(dropoffTimeStr).toISOString() : null,
      end_date: pickupTimeStr ? new Date(pickupTimeStr).toISOString() : null,
      service_type: finalServiceType,
      status,
      source: resolvedSource,
      ghl_dropoff_appointment_id: dropoffId,
      ghl_pickup_appointment_id: pickupId,
      kennel_status: 'needs_size',
      last_modified_source: 'portal',
      last_synced_at: new Date().toISOString(),
      ghl_date_added: dropoff ? new Date(dropoff['Date added']).toISOString() : new Date(pickup['Date added']).toISOString()
    };

    try {
      let existingStay = null;
      if (dropoffId) {
        const { data } = await supabase.from('boarding_stays').select('id').eq('ghl_dropoff_appointment_id', dropoffId).limit(1);
        if (data && data.length > 0) existingStay = data[0];
      }
      if (!existingStay && pickupId) {
        const { data } = await supabase.from('boarding_stays').select('id').eq('ghl_pickup_appointment_id', pickupId).limit(1);
        if (data && data.length > 0) existingStay = data[0];
      }

      if (existingStay) {
        await supabase.from('boarding_stays').update(payload).eq('id', existingStay.id);
        updated++;
      } else {
        await supabase.from('boarding_stays').insert(payload);
        inserted++;
      }
    } catch (dbErr) {
      console.error(`  ✗ Database sync error for ${stay.name}:`, dbErr.message);
      errors++;
    }
  }

  console.log(`\n========================================`);
  console.log(`Safe-Upsert Production Sync Concluded.`);
  console.log(`  New Rows Created:     ${inserted}`);
  console.log(`  Existing Rows Updated: ${updated}`);
  console.log(`  Database Rejections:   ${errors}`);
  console.log(`========================================`);
}

runImport().catch(console.error);
