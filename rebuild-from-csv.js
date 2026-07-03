// ============================================================
// The Dogs Spot — Rebuild Bookings from Clean CSV
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,
};

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

// Simple native CSV parser line splitter to avoid external dependencies
function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
  if (lines.length === 0) return [];

  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    // Basic comma-split logic (assumes data doesn't contain internal commas)
    const values = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    if (values.length !== headers.length) continue;

    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || null;
    });
    records.push(row);
  }
  return records;
}

async function runImport() {
  const csvPath = path.join(__dirname, 'stays.csv');
  if (!fs.existsSync(csvPath)) {
    console.error(`Error: Could not find 'stays.csv' in ${__dirname}`);
    process.exit(1);
  }

  const rows = parseCSV(csvPath);
  console.log(`Parsed ${rows.length} records from CSV. Starting database insertion...\n`);

  let inserted = 0;
  let errors = 0;

  for (const row of rows) {
    const payload = {
      contact_id: row.contact_id,
      owner_name: row.owner_name,
      owner_email: row.owner_email,
      owner_phone: row.owner_phone,
      start_date: row.start_date ? new Date(row.start_date).toISOString() : null,
      end_date: row.end_date ? new Date(row.end_date).toISOString() : null,
      service_type: row.service_type || 'boarding',
      status: row.status || 'confirmed',
      source: row.source || 'internal',
      ghl_dropoff_appointment_id: row.ghl_dropoff_id || null,
      ghl_pickup_appointment_id: row.ghl_pickup_id || null,
      kennel_type: row.kennel_type || null,
      kennel_grad_status: row.kennel_grad_status || null,
      kennel_status: row.kennel_type ? 'unassigned' : 'needs_size',
      last_modified_source: 'portal',
      last_synced_at: new Date().toISOString(),
      ghl_date_added: row.start_date ? new Date(row.start_date).toISOString() : new Date().toISOString()
    };

    const { error } = await supabase.from('boarding_stays').insert(payload);

    if (error) {
      console.error(`✗ Error inserting row for ${row.owner_name}:`, error.message);
      errors++;
    } else {
      console.log(`✓ Successfully loaded stay for ${row.owner_name}`);
      inserted++;
    }
  }

  console.log(`\n========================================`);
  console.log(`CSV Import complete.`);
  console.log(`  Successfully Created: ${inserted}`);
  console.log(`  Failed Errors:        ${errors}`);
  console.log(`========================================`);
}

// Clear out old data from Supabase before running
async function clearAndRun() {
  console.log('Clearing old system history entries...');
  await supabase.from('sync_log').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('boarding_stays').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await runImport();
}

clearAndRun().catch(console.error);
