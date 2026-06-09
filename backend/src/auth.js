// Telegram InitData Verification - Secure HMAC SHA-256
const crypto = require('crypto');

function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) {
    return { valid: false, error: 'Missing initData or botToken' };
  }

  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');

  // Sort params
  const sortedParams = Array.from(urlParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  // Create secret key
  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  // Calculate hash
  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(sortedParams)
    .digest('hex');

  if (calculatedHash !== hash) {
    return { valid: false, error: 'Invalid signature' };
  }

  // Check auth_date (max 24h)
  const authDate = parseInt(urlParams.get('auth_date'));
  const now = Math.floor(Date.now() / 1000);
  if (now - authDate > 86400) {
    return { valid: false, error: 'Auth expired (max 24h)' };
  }

  // Parse user
  const userStr = urlParams.get('user');
  if (!userStr) {
    return { valid: false, error: 'No user data' };
  }

  try {
    const user = JSON.parse(userStr);
    return { valid: true, user, initData };
  } catch (e) {
    return { valid: false, error: 'Invalid user data' };
  }
}

module.exports = { verifyTelegramInitData };
