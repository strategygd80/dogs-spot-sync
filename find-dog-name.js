// ============================================================
// ONE-OFF DIAGNOSTIC — finds a contact by name and prints their
// raw customFields array, so we can confirm the exact field ID
// GHL uses for "Dog's Name". Safe to run any time; makes no
// changes to GHL or Supabase.
//
// Usage:
//   node find-dog-name.js "Scott Davenport"
// ============================================================

require('dotenv').config();
const axios = require('axios');

const CONFIG = {
  GHL_TOKEN:    process.env.GHL_TOKEN,
  GHL_LOCATION: process.env.GHL_LOCATION,
};

const ghl = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: {
    Authorization: `Bearer ${CONFIG.GHL_TOKEN}`,
    Version: '2021-04-15',
    'Content-Type': 'application/json',
  },
});

async function main() {
  const searchName = process.argv[2] || 'Scott Davenport';
  console.log(`Searching for contact: "${searchName}"...\n`);

  try {
    const res = await ghl.get('/contacts/', {
      params: {
        locationId: CONFIG.GHL_LOCATION,
        query: searchName,
        limit: 5,
      },
    });

    const contacts = res.data?.contacts || [];
    if (contacts.length === 0) {
      console.log('No contacts found matching that name. Try a different spelling or check GHL_LOCATION in .env.');
      return;
    }

    for (const contact of contacts) {
      console.log('========================================');
      console.log(`Name: ${contact.firstName || ''} ${contact.lastName || ''} (id: ${contact.id})`);
      console.log('Raw customFields array:');
      console.log(JSON.stringify(contact.customFields || contact.customField || 'NONE FOUND', null, 2));
      console.log('========================================\n');
    }

    console.log('Look for the entry whose value is "Val" (or whichever dog name you expect).');
    console.log('Note the "id" on that entry — that\'s the field ID we need.');
  } catch (err) {
    console.error('Request failed:', err.response?.data || err.message);
  }
}

main();
