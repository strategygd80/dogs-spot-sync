// ============================================================
// The Dogs Spot — Post-Import Dog Name Sync Engine
// ============================================================
require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const CONFIG = {
  GHL_TOKEN:    process.env.GHL_TOKEN,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,
};

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
const ghl = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: {
    Authorization: `Bearer ${CONFIG.GHL_TOKEN}`,
    Version: '2021-04-15',
    'Content-Type': 'application/json',
  },
});

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

async function syncDogNames() {
  console.log('Fetching stays missing dog names from Supabase...');
  
  // Pull all records to inspect or update
  const { data: stays, error } = await supabase
    .from('boarding_stays')
    .select('id, contact_id, owner_name, dog_name');

  if (error) {
    console.error('Failed to query Supabase:', error.message);
    return;
  }

  console.log(`Found ${stays.length} records to verify. Querying GoHighLevel Profiles...\n`);

  const contactMap = new Map();
  let updated = 0;
  let skipped = 0;

  for (const stay of stays) {
    if (!stay.contact_id) {
      skipped++;
      continue;
    }

    let dogName = null;

    // Check memory cache first to avoid hammering the GHL API for repeat clients
    if (contactMap.has(stay.contact_id)) {
      dogName = contactMap.get(stay.contact_id);
    } else {
      try {
        const res = await ghl.get(`/contacts/${stay.contact_id}`);
        const contact = res.data?.contact || null;
        dogName = resolveDogName(contact);
        contactMap.set(stay.contact_id, dogName);
      } catch (err) {
        console.error(`  ✗ Failed fetching GHL profile for ${stay.owner_name} (${stay.contact_id})`);
        continue;
      }
    }

    if (dogName) {
      const { error: updateErr } = await supabase
        .from('boarding_stays')
        .update({ dog_name: dogName })
        .eq('id', stay.id);

      if (updateErr) {
        console.error(`  ✗ Failed updating dog name in DB for stay ID ${stay.id}`);
      } else {
        console.log(`  ✓ Updated ${stay.owner_name}'s dog name -> ${dogName}`);
        updated++;
      }
    } else {
      skipped++;
    }
  }

  console.log(`\n========================================`);
  console.log(`Dog Name Sync Complete.`);
  console.log(`  Records Updated:  ${updated}`);
  console.log(`  Records Skipped:  ${skipped}`);
  console.log(`========================================`);
}

syncDogNames().catch(console.error);
