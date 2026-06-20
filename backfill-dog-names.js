// ============================================================
// BACKFILL DOG NAMES ONLY
// ============================================================
// Reads every boarding_stays row where dog_name is null,
// looks up the contact in GHL, and patches ONLY dog_name.
// Nothing else in the row is touched.
//
// Usage:
//   node backfill-dog-names.js --dry-run   (print what would change)
//   node backfill-dog-names.js             (write to Supabase)
// ============================================================

require('dotenv').config();
const axios  = require('axios');
const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = process.argv.includes('--dry-run');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const ghl = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: {
    Authorization: `Bearer ${process.env.GHL_TOKEN}`,
    Version: '2021-04-15',
    'Content-Type': 'application/json',
  },
});

// The two confirmed field IDs for dog name (from Scott Davenport lookup)
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

const contactCache = new Map();
async function getContact(contactId) {
  if (contactCache.has(contactId)) return contactCache.get(contactId);
  try {
    const res = await ghl.get(`/contacts/${contactId}`);
    const contact = res.data?.contact || null;
    contactCache.set(contactId, contact);
    return contact;
  } catch (err) {
    console.error(`  GHL error for contact ${contactId}:`, err.response?.data?.message || err.message);
    return null;
  }
}

async function main() {
  console.log(DRY_RUN ? 'Backfilling dog names (DRY RUN)...\n' : 'Backfilling dog names...\n');

  // Fetch all rows missing dog_name that have a real contact_id
  const { data: rows, error } = await supabase
    .from('boarding_stays')
    .select('id, contact_id, owner_name, dog_name')
    .is('dog_name', null)
    .not('contact_id', 'in', '("csv-import","")');

  if (error) {
    console.error('Failed to fetch rows from Supabase:', error.message);
    process.exit(1);
  }

  console.log(`Found ${rows.length} rows with missing dog_name.\n`);

  let updated = 0, skipped = 0, errors = 0;

  for (const row of rows) {
    const contact = await getContact(row.contact_id);
    const dogName = resolveDogName(contact);

    if (!dogName) {
      console.log(`  SKIP  ${row.owner_name || row.id} — no dog name found in GHL`);
      skipped++;
      continue;
    }

    console.log(`  ${DRY_RUN ? 'WOULD UPDATE' : 'UPDATE'} ${row.owner_name || row.id} → "${dogName}"`);

    if (!DRY_RUN) {
      const { error: updateError } = await supabase
        .from('boarding_stays')
        .update({ dog_name: dogName })
        .eq('id', row.id);

      if (updateError) {
        console.error(`    ERROR updating row ${row.id}:`, updateError.message);
        errors++;
      } else {
        updated++;
      }
    } else {
      updated++;
    }
  }

  console.log(`\n========================================`);
  console.log(`Dog name backfill ${DRY_RUN ? '(dry run) ' : ''}complete.`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped: ${skipped} (no dog name in GHL)`);
  console.log(`  Errors:  ${errors}`);
  console.log(`========================================`);
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
