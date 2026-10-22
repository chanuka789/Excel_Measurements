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

test('users can be listed in APP_USERS and APP_USERS_MORE', async () => {
  const { usersText, parseUsers } = await import('../src/auth.js');
  const t = usersText({ APP_USERS: 'a@x.com | A | admin | scrypt$1$2', APP_USERS_MORE: 'b@x.com | B | user | scrypt$3$4' });
  assert.equal(parseUsers(t).users.length, 2);
  assert.equal(usersText({ APP_USERS_MORE: 'b@x.com | B | user | scrypt$3$4' }).split('\n').length, 1);
});
