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
  console.log('Retrieving stays needing contact resolution from Supabase...');
  const { data: stays, error } = await supabase
    .from('boarding_stays')
    .select('id, owner_name, owner_email, owner_phone')
    .eq('contact_id', 'PENDING_POST_SYNC');

  if (error) {
    console.error('Failed querying stays from Supabase:', error.message);
    return;
  }

  console.log(`Processing profile matches for ${stays.length} records against GoHighLevel... \n`);

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
        
        // FIXED: Removed trailing slashes from the endpoints to prevent 404/Authentication drops
        if (stay.owner_phone) {
          const res = await ghl.get('/contacts', {
            params: { locationId: CONFIG.GHL_LOCATION, query: stay.owner_phone }
          });
          if (res.data?.contacts?.length > 0) ghlContact = res.data.contacts[0];
        }
        
        if (!ghlContact && stay.owner_email) {
          const res = await ghl.get('/contacts', {
            params: { locationId: CONFIG.GHL_LOCATION, query: stay.owner_email }
          });
          if (res.data?.contacts?.length > 0) ghlContact = res.data.contacts[0];
        }

        if (ghlContact) {
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
        const errMsg = err.response?.data?.message || err.response?.data || err.message;
        console.error(`  ✗ Profile retrieval block for ${stay.owner_name}: ${errMsg}`);
        continue;
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
        console.error(`  ✗ DB write block on stay update targeting ID ${stay.id}: ${dbErr.message}`);
      } else {
        console.log(`  ✓ Synced ${stay.owner_name} -> Dog: ${resolvedProfile.dogName || 'None Found'}`);
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
