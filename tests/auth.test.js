import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, parseUsers } from '../src/auth.js';

test('password hashing round-trip and rejects wrong passwords', () => {
  const h = hashPassword('correct horse battery');
  assert.match(h, /^scrypt\$/);
  assert.ok(verifyPassword('correct horse battery', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.ok(!verifyPassword('x', 'not-a-hash'));
  assert.throws(() => hashPassword('short'), /at least 8/);
});

test('APP_USERS parsing: valid lines, comments, bad lines reported', () => {
  const h = hashPassword('password-123');
  const { users, problems } = parseUsers(`# team
    A@Test.com | Alice | admin | ${h}
    bob@test.com | Bob | user | ${h}
    bad-email | X | user | ${h}
    carl@test.com | Carl | boss | ${h}
    dan@test.com | Dan | user | plaintext`);
  assert.deepEqual(users.map(u => [u.email, u.role]), [['a@test.com', 'admin'], ['bob@test.com', 'user']]);
  assert.equal(problems.length, 3);
});
