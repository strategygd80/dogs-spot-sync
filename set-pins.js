// ============================================================
// The Dogs Spot — Staff PIN Encryption & Authorization Setup
// ============================================================
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY, // Must be the service_role key
};

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

// 🔐 CHANGE THESE TO YOUR REAL LIVE STAFF PINS (4-6 DIGITS)
const REAL_STAFF_PINS = {
  'info@thedogsspotga.com':   '1472', // <-- Replace with real Trainer PIN
  'info+1@thedogsspotga.com': '2583', // <-- Replace with real Virtual Staff PIN
  'otchx4@gmail.com':         '9061', // <-- Replace with real Super User PIN
};

async function encryptAndDeployPins() {
  console.log('Initiating staff PIN encryption and deployment sequence...\n');

  for (const [email, plainPin] of Object.entries(REAL_STAFF_PINS)) {
    console.log(`Generating secure cryptographic hash for: ${email}...`);
    
    // Hash the plain text pin exactly how server.js expects to verify it
    const salt = await bcrypt.genSalt(10);
    const encryptedHash = await bcrypt.hash(String(plainPin), salt);

    const { error } = await supabase
      .from('portal_users')
      .update({ 
        pin_hash: encryptedHash,
        failed_attempts: 0, // Reset any existing lockouts while updating
        locked_until: null
      })
      .eq('email', email.toLowerCase().trim());

    if (error) {
      console.error(`  ✗ Database rejected update sequence for ${email}:`, error.message);
    } else {
      console.log(`  ✓ Live authorization code securely locked in for ${email}`);
    }
  }

  console.log('\n========================================');
  console.log('PIN Synchronization Complete.');
  console.log('You can now log into your live portal panels.');
  console.log('========================================');
}

encryptAndDeployPins().catch(console.error);
