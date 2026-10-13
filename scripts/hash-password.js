#!/usr/bin/env node
// Make a password hash for the APP_USERS Railway variable.
//   npm run hash-password -- "the password"          (or run without an argument to be asked)
import readline from 'readline';
import { hashPassword } from '../src/auth.js';

async function ask() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question('Password (min 8 characters): ', (a) => { rl.close(); r(a); }));
}
const pw = process.argv[2] || await ask();
try {
  const h = hashPassword(pw);
  console.log('\nHash:\n' + h);
  console.log('\nAPP_USERS line example:\nname@example.com | Full Name | user | ' + h);
} catch (e) { console.error(e.message); process.exit(1); }
