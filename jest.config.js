/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  testTimeout: 30000,
  setupFiles: ['<rootDir>/src/__tests__/setup.ts'],
};
