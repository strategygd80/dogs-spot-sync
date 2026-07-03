// ============================================================
// The Dogs Spot — Rebuild Bookings from GHL UI CSV Export
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,
  TIMEZONE: 'America/New_York',
};

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

// Map text-based Calendar strings from UI export to Service Types and Roles
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
  'bundle pick-up':             { serviceType: 'bundle',      role: 'pickup',  source: 'internal' }
};

const PAIRING_GROUPS = {
  boarding:    'boarding',
  basic:       'flexible',
  bundle:      'flexible',
  leash_free:  'flexible',
  service_dog: 'flexible',
  community:   'flexible',
};

function normalizePhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  // Handle standard line split variants cleanly
  const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
  if (lines.length === 0) return [];

  // Match columns even with loose spacing/invisible quote marks
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    // Robust regex split to handle fields wrapped in quotes containing internal commas safely
    const matches = lines[i].match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || lines[i].split(',');
    const values = matches.map(v => v.trim().replace(/^"|"$/g, ''));
    
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

  const appointments = parseCSV(csvPath);
  console.log(`Parsed ${appointments.length} raw appointments. Processing chronological pairing loops...`);

  // Order chronologically by Date Added to match linear session tracking sequence
  appointments.sort((a, b) => new Date(a['Date added'] || 0) - new Date(b['Date added'] || 0));

  const stays = [];
  const TWENTY_FOUR_HOURS_MS = 24 * 3600 * 1000;

  for (const appt of appointments) {
    const calString = String(appt['Calendar']).trim().toLowerCase();
    const calMeta = CALENDAR_TEXT_LOOKUP[calString];
    if (!calMeta) {
      console.warn(`  ↳ Skipping unknown calendar label classification: "${appt['Calendar']}"`);
      continue;
    }

    const { serviceType, role, source } = calMeta;
    const group = PAIRING_GROUPS[serviceType] || 'flexible';
    const isDropoff = role === 'dropoff';
    const missingField = isDropoff ? 'pickup' : 'dropoff';

    const ownerName = appt['Contact name'];
    const ownerEmail = appt['Email'] ? String(appt['Email']).trim().toLowerCase() : '';
    const normPhone = normalizePhone(appt['Phone']);

    const apptBookedAtMs = new Date(appt['Date added']).getTime();

    let bestMatch = null;

    if (group === 'boarding') {
      let minDiff = Infinity;
      for (const stay of stays) {
        // Validate matching markers when a genuine contact_id column is absent
        const phoneMatch = normPhone && stay.phone === normPhone;
        const emailMatch = ownerEmail && stay.email === ownerEmail;
        const nameMatch = ownerName && stay.name.toLowerCase() === ownerName.toLowerCase();

        if (!(phoneMatch || emailMatch || nameMatch) || stay.group !== 'boarding' || stay[missingField]) continue;

        const targetLeg = stay.dropoff || stay.pickup;
        const targetBookedAtMs = new Date(targetLeg['Date added']).getTime();
        const diff = Math.abs(targetBookedAtMs - apptBookedAtMs);

        if (diff <= TWENTY_FOUR_HOURS_MS && diff < minDiff) {
          minDiff = diff;
          bestMatch = stay;
        }
      }
    } else {
      // Flexible Pool FIFO Cross-Service Alignment
      for (const stay of stays) {
        const phoneMatch = normPhone && stay.phone === normPhone;
        const emailMatch = ownerEmail && stay.email === ownerEmail;
        const nameMatch = ownerName && stay.name.toLowerCase() === ownerName.toLowerCase();

        if ((phoneMatch || emailMatch || nameMatch) && stay.group === 'flexible' && !stay[missingField]) {
          bestMatch = stay;
          break;
        }
      }
    }

    if (bestMatch) {
      if (isDropoff) {
        bestMatch.dropoff = appt;
        bestMatch.serviceType = serviceType;
      } else {
        bestMatch.pickup = appt;
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
        dropoff: isDropoff ? appt : null,
        pickup:  !isDropoff ? appt : null,
      });
    }
  }

  console.log(`\nProcessing upload arrays for ${stays.length} unified stays into Supabase...`);
  let inserted = 0; let errors = 0;

  for (const stay of stays) {
    const { dropoff, pickup } = stay;

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

    const payload = {
      contact_id: 'PENDING_POST_SYNC', // Populated explicitly via follow-up profile matching query
      owner_name: stay.name,
      owner_email: stay.email || null,
      owner_phone: stay.phone || null,
      dog_name: null, 
      start_date: dropoffTimeStr ? new Date(dropoffTimeStr).toISOString() : null,
      end_date: pickupTimeStr ? new Date(pickupTimeStr).toISOString() : null,
      service_type: stay.serviceType,
      status,
      source: resolvedSource,
      ghl_dropoff_appointment_id: dropoff ? dropoff['Appointment id'] : null,
      ghl_pickup_appointment_id: pickup ? pickup['Appointment id'] : null,
      kennel_status: 'needs_size',
      last_modified_source: 'portal',
      last_synced_at: new Date().toISOString(),
      ghl_date_added: dropoff ? new Date(dropoff['Date added']).toISOString() : new Date(pickup['Date added']).toISOString()
    };

    const { error } = await supabase.from('boarding_stays').insert(payload);
    if (error) {
      console.error(`  ✗ Database rejected entry for ${stay.name}:`, error.message);
      errors++;
    } else {
      inserted++;
    }
  }

  console.log(`\n========================================`);
  console.log(`CSV Import Phase Complete.`);
  console.log(`  Stays Rebuilt & Created: ${inserted}`);
  console.log(`  Failed DB Submissions:  ${errors}`);
  console.log(`========================================`);
}

runImport().catch(console.error);
