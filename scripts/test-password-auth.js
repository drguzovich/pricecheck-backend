'use strict';

const assert = require('assert');
const { hashPassword, normalizeEmail, validateRegistration, verifyPassword } = require('../src/userAuth');

(async () => {
  assert.equal(normalizeEmail('  Shopper@Example.COM '), 'shopper@example.com');
  assert.equal(validateRegistration({ email: 'not-an-email', displayName: 'Shopper', password: 'long-enough-password' }).error, 'Enter a valid email address.');
  assert.equal(validateRegistration({ email: 'shopper@example.com', displayName: 'S', password: 'long-enough-password' }).error, 'Enter a name between 2 and 80 characters.');
  assert.equal(validateRegistration({ email: 'shopper@example.com', displayName: 'Shopper', password: 'short' }).error, 'Use a password between 10 and 128 characters.');

  const hash = await hashPassword('a-secure-password');
  assert.match(hash, /^scrypt\$[^$]+\$[^$]+$/);
  assert.equal(await verifyPassword('a-secure-password', hash), true);
  assert.equal(await verifyPassword('wrong-password', hash), false);
  console.log('password authentication checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
