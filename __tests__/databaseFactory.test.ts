/**
 * Regression test for the DatabaseFactory memo guard.
 *
 * DatabaseFactory.getDatabase() used to assign `instance` on every call without
 * ever checking it, so each call constructed a new PostgresDatabase — and its
 * constructor opens a `pg` Pool that is never closed. The manifest endpoint
 * calls getDatabase() twice per request, so the leak scaled with traffic:
 * Aurora's connection count was observed peaking at 81, where a single pool
 * caps at pg's default of 10.
 *
 * The assertion that actually catches a regression is the Pool construction
 * count, not just instance identity.
 */

// `export {}` marks this file as a module; without it --isolatedModules
// treats a require-only test file as a global script (TS1208).
export {};

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    query: jest.fn(),
  })),
}));

function loadFactory() {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const pg = require('pg');
  const { DatabaseFactory } = require('../apiUtils/database/DatabaseFactory');
  /* eslint-enable @typescript-eslint/no-var-requires */
  return { PoolMock: pg.Pool as jest.Mock, DatabaseFactory };
}

describe('DatabaseFactory', () => {
  const originalDbType = process.env.DB_TYPE;

  beforeEach(() => {
    jest.resetModules();
    process.env.DB_TYPE = 'postgres';
  });

  afterAll(() => {
    process.env.DB_TYPE = originalDbType;
  });

  it('memoizes the instance and opens exactly one pg Pool', () => {
    const { PoolMock, DatabaseFactory } = loadFactory();

    const first = DatabaseFactory.getDatabase();
    const second = DatabaseFactory.getDatabase();
    const third = DatabaseFactory.getDatabase();

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(PoolMock).toHaveBeenCalledTimes(1);
  });

  it('registers an error handler on the pool so idle-client errors cannot crash the process', () => {
    const { PoolMock, DatabaseFactory } = loadFactory();

    DatabaseFactory.getDatabase();

    const poolInstance = PoolMock.mock.results[0].value;
    expect(poolInstance.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('bounds the pool and never waits forever for a connection', () => {
    const { PoolMock, DatabaseFactory } = loadFactory();

    DatabaseFactory.getDatabase();

    const config = PoolMock.mock.calls[0][0];
    expect(config.max).toBeGreaterThan(0);
    expect(config.idleTimeoutMillis).toBeGreaterThan(0);
    // pg defaults this to 0, meaning "wait forever" — the whole point of the fix.
    expect(config.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it('throws for an unsupported DB_TYPE', () => {
    process.env.DB_TYPE = 'not-a-real-database';
    const { DatabaseFactory } = loadFactory();

    expect(() => DatabaseFactory.getDatabase()).toThrow('Unsupported database type');
  });
});
