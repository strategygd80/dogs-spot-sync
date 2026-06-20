// ============================================================
// The Dogs Spot — Set Portal User PINs
// One-time script: hashes and stores a PIN for each staff user
// ============================================================
// Setup:
//   npm install @supabase/supabase-js bcryptjs dotenv
//   node set-pins.js
// ============================================================
// EDIT THE PINS BELOW before running, then run once.
// Re-run any time to change a PIN later.
// ============================================================

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── EDIT THESE PINS ──────────────────────────────────────────
// Use 4-6 digits. Each user should have a unique PIN.
const PINS = {
  'info@thedogsspotga.com':   '1472',   // Trainer
  'info+1@thedogsspotga.com': '2583',   // Virtual Staff
  'otchx4@gmail.com':         '9061',   // Super User
};
// ──────────────────────────────────────────────────────────────

async function setPins() {
  console.log('Setting PINs for portal users...\n');

  for (const [email, pin] of Object.entries(PINS)) {
    if (!/^\d{4,6}$/.test(pin)) {
      console.error(`✗ Skipping ${email}: PIN must be 4-6 digits`);
      continue;
    }

    const pinHash = await bcrypt.hash(pin, 10);

    const { data, error } = await supabase
      .from('portal_users')
      .update({ pin_hash: pinHash, failed_attempts: 0, locked_until: null })
      .eq('email', email)
      .select();

    if (error) {
      console.error(`✗ Failed for ${email}:`, error.message);
    } else if (!data || data.length === 0) {
      console.error(`✗ No user found with email ${email} — check the portal_users table`);
    } else {
      console.log(`✓ PIN set for ${email}`);
    }
  }

  console.log('\nDone. You can now log in with email + PIN.');
  console.log('IMPORTANT: delete or clear the PINS object above after running, so plaintext PINs aren\'t left in this file.');
}

setPins().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
