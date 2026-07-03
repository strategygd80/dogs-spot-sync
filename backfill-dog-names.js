// ============================================================
// The Dogs Spot — Contact ID & Dog Name Post-Sync Processor
// ============================================================
require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const CONFIG = {
  GHL_TOKEN:    process.env.GHL_TOKEN,
  GHL_LOCATION: process.env.GHL_LOCATION,
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

async function runProfileSync() {
  console.log('Retrieving entries from Supabase to run contact resolution...');
  const { data: stays, error } = await supabase
    .from('boarding_stays')
    .select('id, owner_name, owner_email, owner_phone');

  if (error) {
    console.error('Failed querying stays:', error.message);
    return;
  }

  console.log(`Processing deep profile matches for ${stays.length} stays across GoHighLevel... \n`);

  const memoryCache = new Map();
  let completed = 0; let skipped = 0;

  for (const stay of stays) {
    const cacheKey = stay.owner_phone || stay.owner_email || stay.owner_name;
    let resolvedProfile = null;

    if (memoryCache.has(cacheKey)) {
      resolvedProfile = memoryCache.get(cacheKey);
    } else {
      try {
        let ghlContact = null;
        // Search strictly by phone first to eliminate names matching multiple family structures
        if (stay.owner_phone) {
          const res = await ghl.get('/contacts/', {
            params: { locationId: CONFIG.GHL_LOCATION, query: stay.owner_phone }
          });
          if (res.data?.contacts?.length > 0) ghlContact = res.data.contacts[0];
        }
        // Fallback search by email if phone yields no records
        if (!ghlContact && stay.owner_email) {
          const res = await ghl.get('/contacts/', {
            params: { locationId: CONFIG.GHL_LOCATION, query: stay.owner_email }
          });
          if (res.data?.contacts?.length > 0) ghlContact = res.data.contacts[0];
        }

        if (ghlContact) {
          // Fetch full contact card to expose internal customFields array mappings
          const details = await ghl.get(`/contacts/${ghlContact.id}`);
          if (details.data?.contact) {
            resolvedProfile = {
              contactId: ghlContact.id,
              dogName: resolveDogName(details.data.contact)
            };
            memoryCache.set(cacheKey, resolvedProfile);
          }
        }
      } catch (err) {
        console.error(`  ✗ Communication failure pulling profile for ${stay.owner_name}`);
      }
    }

    if (resolvedProfile) {
      const { error: dbErr } = await supabase
        .from('boarding_stays')
        .update({
          contact_id: resolvedProfile.contactId,
          dog_name: resolvedProfile.dogName
        })
        .eq('id', stay.id);

      if (dbErr) {
        console.error(`  ✗ DB write block on stay update targeting ID ${stay.id}`);
      } else {
        console.log(`  ✓ Synced ${stay.owner_name} -> Dog: ${resolvedProfile.dogName || 'None Found'} (ID: ${resolvedProfile.contactId})`);
        completed++;
      }
    } else {
      skipped++;
    }
  }

  console.log(`\n========================================`);
  console.log(`Profile Backfill Sequence Concluded.`);
  console.log(`  Stays Fully Resolved: ${completed}`);
  console.log(`  Stays Left Unmatched: ${skipped}`);
  console.log(`========================================`);
}

runProfileSync().catch(console.error);
