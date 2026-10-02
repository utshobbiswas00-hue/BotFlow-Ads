#!/usr/bin/env node
/**
 * Generate the scrypt hash for the staff panel password.
 *
 *   node backend/scripts/hash-admin-password.mjs
 *
 * Paste the printed line into .env (never into a tracked file, never into a
 * screenshot, never into a chat): the hash is what the server compares against,
 * and the plaintext must not end up anywhere the repository can reach.
 *
 * The parameters match `backend/src/utils/password.ts` exactly. If they are ever
 * raised there, old hashes keep working — the stored string carries its own
 * parameters — and new ones use the higher cost.
 */
import crypto from 'node:crypto';
import readline from 'node:readline';

const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_BYTES = 16;
const MAX_MEM = 64 * 1024 * 1024;

function hash(plain) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = crypto.scryptSync(plain, salt, KEY_LEN, { N, r: R, p: P, maxmem: MAX_MEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Hide the typed password when stdin is a TTY. */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      const s = String(char);
      if (s === '\n' || s === '\r' || s === '\u0004') return;
      // Rewrite the prompt so keystrokes are not echoed.
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(question);
    };
    process.stdin.on('data', onData);
    rl.question(question, (answer) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    rl.on('error', reject);
  });
}

async function main() {
  const argPassword = process.argv[2];
  const password = argPassword ?? (await promptHidden('Panel password: '));

  if (!password || password.length < 8) {
    process.stderr.write(
      '\nRefusing to hash a password shorter than 8 characters.\n' +
        'The login endpoint enforces the same floor, so a shorter one would be accepted here and rejected at sign-in.\n\n',
    );
    process.exit(1);
  }

  const stored = hash(password);

  process.stdout.write(
    '\nAdd these three lines to your .env (all three are required, or none):\n\n' +
      '  ADMIN_PANEL_USERNAME=<the panel username>\n' +
      `  ADMIN_PANEL_PASSWORD_HASH=${stored}\n` +
      '  ADMIN_PANEL_ADMIN_TELEGRAM_ID=<your numeric Telegram id>\n' +
      '  # optional, recommended in production:\n' +
      '  ADMIN_PANEL_TOKEN_SECRET=<a long random string>\n\n' +
      'ADMIN_PANEL_ADMIN_TELEGRAM_ID is the account every panel action is attributed to in the audit log.\n' +
      'It must already have opened the bot once, so its user row exists. If that account has no\n' +
      'AdminUser row yet, the first successful login creates one as SUPER_ADMIN and logs a warning.\n\n',
  );

  if (argPassword) {
    process.stdout.write(
      'Note: the password was passed as an argument, so it is in your shell history. Prefer running\n' +
        'this with no argument and typing it at the prompt.\n\n',
    );
  }
}

main().catch((err) => {
  process.stderr.write(`\nFailed to hash: ${err.message}\n\n`);
  process.exit(1);
});
