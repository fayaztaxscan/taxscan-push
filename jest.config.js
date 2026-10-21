/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  testTimeout: 30000,
  // Owner's standing rule (2026-10-21): stay within half of this 4-core / 8 GB Mac.
  // Jest's default (cores - 1 = 7 workers) alone would exceed it.
  maxWorkers: 2,
  setupFiles: ['<rootDir>/src/__tests__/setup.ts'],
};
