// Runs every morning (schedule in netlify.toml) and starts the CB2 / Crate & Barrel stock check.
// The real work happens in cb-stock-check-background.js, which can run for up to
// 15 minutes (scheduled functions are limited to 30 seconds).
const crypto = require('crypto');

exports.handler = async function() {
  const token = crypto.createHash('sha256').update('cb-sync:' + (process.env.SUPABASE_SERVICE_KEY || '')).digest('hex');
  const base = process.env.URL || 'https://mastercove.com';
  try {
    const r = await fetch(base + '/.netlify/functions/cb-stock-check-background', {
      method: 'POST', headers: { 'x-sync-token': token, 'Content-Type': 'application/json' }, body: '{}'
    });
    console.log('CB check started:', r.status);
    return { statusCode: 200, body: 'Started (' + r.status + ')' };
  } catch (e) {
    console.error('Could not start CB check:', e.message);
    return { statusCode: 500, body: 'Could not start' };
  }
};
