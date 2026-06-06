/* eslint-disable no-console */
/**
 * First-user bootstrap CLI — creates an ADMIN User in the configured DB.
 *
 * Usage:
 *   npm run create-admin
 *
 * Prompts for email + password (password is masked on TTY). Validates via
 * the shared passwordPolicy module, bcrypts at cost 12, inserts a single
 * User row with role=ADMIN, isActive=true. Refuses to overwrite if a user
 * with the same email already exists. No flags, no automation hooks —
 * deliberately interactive.
 */

import { createInterface } from 'readline';
import bcrypt from 'bcrypt';
import { prisma } from '../src/lib/prisma';
import { passwordIssue } from '../src/lib/passwordPolicy';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CTRL_C = '';
const BACKSPACE_DEL = '';

function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptPassword(question: string): Promise<string> {
  // No TTY (CI / piped) → fall back to plain stdin without masking.
  if (!process.stdin.isTTY) return promptLine(question);

  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let buf = '';
    const onData = (input: string): void => {
      for (const ch of input) {
        if (ch === CTRL_C) {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (ch === BACKSPACE_DEL || ch === '\b') {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        buf += ch;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const rawEmail = await promptLine('email: ');
  const email = rawEmail.toLowerCase();
  if (!EMAIL_REGEX.test(email)) {
    console.error('invalid email format');
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.error(`user already exists: ${email}`);
    process.exit(1);
  }

  const password = await promptPassword('password: ');
  const issue = passwordIssue(password);
  if (issue) {
    console.error(issue);
    process.exit(1);
  }
  const confirm = await promptPassword('confirm password: ');
  if (confirm !== password) {
    console.error('passwords do not match');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      role: 'ADMIN',
      isActive: true,
    },
  });

  console.log(`created admin: ${user.email} (id ${user.id})`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
