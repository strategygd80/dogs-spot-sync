// ============================================================
// REBUILD boarding_stays FROM GHL CSV EXPORT
// ============================================================
// Why this exists: the live-API-based backfill/pairing logic in
// backfill.js and server.js was mis-threading frequent repeat
// customers (e.g. weekly boarders) — pairing a dropoff with the
// WRONG week's pickup, leaving real appointments orphaned as
// "incomplete" even though every appointment was legitimate.
//
// This script sidesteps that entirely by using a CSV export
// straight from GHL (Reporting > Appointments > Export), which
// has stable appointment IDs, real timestamps, and calendar
// names already labeled. Pairing here is done by strict
// chronological alternation per contact: for each contact, walk
// their boarding-type appointments in time order and pair
// dropoff -> pickup -> dropoff -> pickup, etc. This is much more
// reliable than "closest in time within a window" for someone
// who boards weekly.
//
// This is a FULL REBUILD: it deletes existing rows in
// boarding_stays that originated from sync (last_modified_source
// = 'ghl' or 'csv_rebuild') and reinserts fresh ones from the
// CSV. Rows with last_modified_source = 'portal' (i.e. anything
// staff edited by hand in the app) are left untouched.
//
// Usage:
//   node rebuild-from-csv.js path/to/export.csv --dry-run
//   node rebuild-from-csv.js path/to/export.csv
// ============================================================

require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = process.argv.includes('--dry-run');
const csvPath = process.argv[2];

if (!csvPath || csvPath === '--dry-run') {
  console.error('Usage: node rebuild-from-csv.js path/to/export.csv [--dry-run]');
  process.exit(1);
}

const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,
  TIMEZONE: 'America/New_York',
};

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

// ------------------------------------------------------------
// CALENDAR NAME -> { serviceType, role, pairingGroup }
// Only boarding-type calendars are handled here. Anything else
// (Meet & Greet, training, daycare, pack walks, etc.) is ignored
// entirely — it's not a boarding stay.
// ------------------------------------------------------------
const CALENDAR_MAP = {
  'Boarding Drop Off':          { serviceType: 'boarding',    role: 'dropoff' },
  'Boarding Drop Off - Online': { serviceType: 'boarding',    role: 'dropoff' },
  'Boarding Pick Up':           { serviceType: 'boarding',    role: 'pickup'  },
  'Boarding Pick Up - Online':  { serviceType: 'boarding',    role: 'pickup'  },

  'Basic Drop Off':             { serviceType: 'basic',       role: 'dropoff' },
  'Basic Pick-up':              { serviceType: 'basic',       role: 'pickup'  },
  'Bundle Drop Off':            { serviceType: 'bundle',      role: 'dropoff' },
  'Bundle Pick-up':             { serviceType: 'bundle',      role: 'pickup'  },
  'Leash Free Drop Off':        { serviceType: 'leash_free',  role: 'dropoff' },
  'Leash Free Pick-up':         { serviceType: 'leash_free',  role: 'pickup'  },
  'Service Dog Drop Off':       { serviceType: 'service_dog', role: 'dropoff' },
  'Service Dog Pick-up':        { serviceType: 'service_dog', role: 'pickup'  },
  'Community Drop Off':         { serviceType: 'community',   role: 'dropoff' },
  'Community Pick-up':          { serviceType: 'community',   role: 'pickup'  },
};

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

const EXCLUDED_OUTCOMES = new Set(['cancelled', 'invalid', 'noshow']);

// ------------------------------------------------------------
// CSV PARSING (minimal, no external dependency)
// Handles quoted fields containing commas, per RFC 4180.
// ------------------------------------------------------------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else { field += c; }
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

function parseRequestedTime(str) {
  // Format: "Jul 20 2026 09:10 AM"
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  return d;
}

function getDateStringInTZ(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return formatter.format(date);
}

// ------------------------------------------------------------
// MAIN
// ------------------------------------------------------------
async function main() {
  console.log(DRY_RUN ? 'Starting CSV rebuild (DRY RUN)...\n' : 'Starting CSV rebuild...\n');

  const raw = fs.readFileSync(csvPath, 'utf-8').replace(/^\uFEFF/, ''); // strip BOM
  const table = parseCSV(raw);
  const header = table[0];
  const dataRows = table.slice(1);

  const col = name => header.indexOf(name);
  const idxId       = col('Appointment id');
  const idxTime      = col('Requested time');
  const idxContact   = col('Contact name');
  const idxCalendar  = col('Calendar');
  const idxEmail     = col('Email');
  const idxPhone     = col('Phone');
  const idxOutcome   = col('Outcome');

  if ([idxId, idxTime, idxContact, idxCalendar, idxOutcome].some(i => i === -1)) {
    console.error('CSV is missing one or more expected columns. Found header:', header);
    process.exit(1);
  }

  console.log(`Parsed ${dataRows.length} rows from CSV.\n`);

  // Step 1: filter to boarding-type calendars only, exclude cancelled/invalid/noshow
  const relevant = [];
  for (const r of dataRows) {
    const calendarName = (r[idxCalendar] || '').trim();
    const calMeta = CALENDAR_MAP[calendarName];
    if (!calMeta) continue; // not a boarding-type calendar — ignore (training, daycare, meet & greet, etc.)

    const outcome = (r[idxOutcome] || '').trim().toLowerCase();
    if (EXCLUDED_OUTCOMES.has(outcome)) continue;

    const time = parseRequestedTime(r[idxTime]);
    if (!time) {
      console.warn(`Skipping row with unparseable time: ${r[idxId]} "${r[idxTime]}"`);
      continue;
    }

    relevant.push({
      appointmentId: r[idxId],
      time,
      contactName: (r[idxContact] || '').trim(),
      email: (r[idxEmail] || '').trim(),
      phone: (r[idxPhone] || '').trim(),
      calendarName,
      serviceType: calMeta.serviceType,
      role: calMeta.role,
      pairingGroup: pairingGroupOf(calMeta.serviceType),
      outcome,
    });
  }

  console.log(`${relevant.length} relevant boarding-type appointments (after excluding cancelled/invalid/noshow and non-boarding calendars).\n`);

  // Step 2: group by contact identity. Email is the most stable key when
  // present; fall back to phone, then name, since the CSV has no contact ID.
  const contactKey = a => (a.email || a.phone || a.contactName || 'unknown').toLowerCase();

  const byContact = new Map();
  for (const a of relevant) {
    const key = contactKey(a);
    if (!byContact.has(key)) byContact.set(key, []);
    byContact.get(key).push(a);
  }

  console.log(`${byContact.size} distinct contacts.\n`);

  // Step 3: within each contact, group by pairing group, sort
  // chronologically, and pair strictly by alternation: the Nth dropoff
  // pairs with the Nth pickup in time order. This is what correctly
  // threads frequent repeat customers instead of "closest in time".
  const stays = [];

  for (const [key, appts] of byContact) {
    const byGroup = new Map();
    for (const a of appts) {
      if (!byGroup.has(a.pairingGroup)) byGroup.set(a.pairingGroup, []);
      byGroup.get(a.pairingGroup).push(a);
    }

    for (const [group, groupAppts] of byGroup) {
      const dropoffs = groupAppts.filter(a => a.role === 'dropoff').sort((a, b) => a.time - b.time);
      const pickups  = groupAppts.filter(a => a.role === 'pickup').sort((a, b) => a.time - b.time);

      // Two-pointer chronological merge: walk both lists in time order and
      // pair a dropoff with the next pickup ONLY if that pickup is at or
      // after the dropoff. If a pickup comes before the next available
      // dropoff (e.g. its real dropoff was cancelled/excluded), it's
      // emitted standalone as incomplete rather than force-paired backwards.
      let di = 0, pi = 0;
      while (di < dropoffs.length || pi < pickups.length) {
        const d = di < dropoffs.length ? dropoffs[di] : null;
        const p = pi < pickups.length  ? pickups[pi]  : null;

        if (d && p) {
          if (p.time >= d.time) {
            stays.push({ contactName: d.contactName, email: d.email, phone: d.phone, serviceType: d.serviceType, dropoff: d, pickup: p });
            di++; pi++;
          } else {
            // Pickup predates this dropoff — it has no valid dropoff partner here.
            stays.push({ contactName: p.contactName, email: p.email, phone: p.phone, serviceType: p.serviceType, dropoff: null, pickup: p });
            pi++;
          }
        } else if (d) {
          stays.push({ contactName: d.contactName, email: d.email, phone: d.phone, serviceType: d.serviceType, dropoff: d, pickup: null });
          di++;
        } else if (p) {
          stays.push({ contactName: p.contactName, email: p.email, phone: p.phone, serviceType: p.serviceType, dropoff: null, pickup: p });
          pi++;
        }
      }
    }
  }

  console.log(`Built ${stays.length} stay(s) from chronological pairing.\n`);

  // Step 4: compute status per stay
  const now = new Date();
  const todayStr = getDateStringInTZ(now, CONFIG.TIMEZONE);

  let incompleteCount = 0;
  for (const stay of stays) {
    let status = 'confirmed';
    if (!stay.dropoff || !stay.pickup) { status = 'incomplete'; incompleteCount++; }

    if (status === 'confirmed') {
      const startStr = getDateStringInTZ(stay.dropoff.time, CONFIG.TIMEZONE);
      const endStr    = getDateStringInTZ(stay.pickup.time,  CONFIG.TIMEZONE);
      if (startStr <= todayStr && endStr >= todayStr) status = 'active';
      else if (endStr < todayStr) status = 'completed';
    }
    stay.status = status;
  }

  console.log(`Status breakdown:`);
  console.log(`  incomplete: ${incompleteCount}`);
  console.log(`  other:      ${stays.length - incompleteCount}\n`);

  if (DRY_RUN) {
    console.log('--- Sample of first 15 stays ---');
    stays.slice(0, 15).forEach(s => {
      console.log(`  ${s.contactName} [${s.serviceType}] ${s.status} — dropoff:${s.dropoff?.time.toDateString() || 'MISSING'} pickup:${s.pickup?.time.toDateString() || 'MISSING'}`);
    });
    console.log(`\n[dry-run] Would delete existing synced rows and insert ${stays.length} stays. No changes made.`);
    return;
  }

  // Step 5a: snapshot existing dog_name values keyed by appointment ID,
  // so we can restore them after the wipe (the CSV doesn't include dog names).
  console.log('Snapshotting existing dog_name values before wipe...');
  const dogNameByDropoff = new Map();
  const dogNameByPickup  = new Map();
  const contactIdByDropoff = new Map();
  const contactIdByPickup  = new Map();
  let snapshotCursor = 0;
  const SNAP_BATCH = 1000;
  while (true) {
    const { data: snap, error: snapErr } = await supabase
      .from('boarding_stays')
      .select('ghl_dropoff_appointment_id, ghl_pickup_appointment_id, dog_name, contact_id')
      .range(snapshotCursor, snapshotCursor + SNAP_BATCH - 1);
    if (snapErr || !snap || snap.length === 0) break;
    for (const row of snap) {
      if (row.dog_name) {
        if (row.ghl_dropoff_appointment_id) dogNameByDropoff.set(row.ghl_dropoff_appointment_id, row.dog_name);
        if (row.ghl_pickup_appointment_id)  dogNameByPickup.set(row.ghl_pickup_appointment_id,  row.dog_name);
      }
      if (row.contact_id) {
        if (row.ghl_dropoff_appointment_id) contactIdByDropoff.set(row.ghl_dropoff_appointment_id, row.contact_id);
        if (row.ghl_pickup_appointment_id)  contactIdByPickup.set(row.ghl_pickup_appointment_id,  row.contact_id);
      }
    }
    snapshotCursor += snap.length;
    if (snap.length < SNAP_BATCH) break;
  }
  console.log(`Snapshotted dog_name for ${dogNameByDropoff.size + dogNameByPickup.size} appointment references.\n`);

  // Step 5b: wipe existing synced rows (preserve anything staff hand-edited
  // via the portal), then insert fresh data.
  console.log('Deleting existing synced rows from boarding_stays (preserving portal-edited rows)...');
  const { error: deleteError, count } = await supabase
    .from('boarding_stays')
    .delete({ count: 'exact' })
    .neq('last_modified_source', 'portal');

  if (deleteError) {
    console.error('Failed to delete existing rows:', deleteError.message);
    process.exit(1);
  }
  console.log(`Deleted ${count ?? 'an unknown number of'} rows.\n`);

  console.log('Inserting rebuilt stays...');
  let inserted = 0, errors = 0;
  const BATCH_SIZE = 100;
  for (let i = 0; i < stays.length; i += BATCH_SIZE) {
    const batch = stays.slice(i, i + BATCH_SIZE).map(s => {
      const dropoffId = s.dropoff?.appointmentId || null;
      const pickupId  = s.pickup?.appointmentId  || null;
      // Restore dog_name from snapshot (prefer dropoff key, fall back to pickup key)
      const dog_name =
        (dropoffId && dogNameByDropoff.get(dropoffId)) ||
        (pickupId  && dogNameByPickup.get(pickupId))   || null;
      const contact_id =
        (dropoffId && contactIdByDropoff.get(dropoffId)) ||
        (pickupId  && contactIdByPickup.get(pickupId))   || null;
      return {
        ghl_dropoff_appointment_id: dropoffId,
        ghl_pickup_appointment_id:  pickupId,
        contact_id,
        owner_name:  s.contactName || null,
        owner_email: s.email || null,
        owner_phone: s.phone || null,
        dog_name,
        start_date: s.dropoff?.time.toISOString() || null,
        end_date:   s.pickup?.time.toISOString()  || null,
        source: 'internal',
        service_type: s.serviceType,
        status: s.status,
        is_returning_client: false,
        last_modified_source: 'csv_rebuild',
        last_synced_at: new Date().toISOString(),
      };
    });

    const { error } = await supabase.from('boarding_stays').insert(batch);
    if (error) {
      console.error(`Batch ${i / BATCH_SIZE + 1} failed:`, error.message);
      errors += batch.length;
    } else {
      inserted += batch.length;
    }
    console.log(`  ... ${Math.min(i + BATCH_SIZE, stays.length)} / ${stays.length}`);
  }

  console.log(`\n========================================`);
  console.log(`Rebuild complete.`);
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Errors:   ${errors}`);
  console.log(`========================================`);
}

main().catch(err => {
  console.error('Rebuild failed:', err);
  process.exit(1);
});
