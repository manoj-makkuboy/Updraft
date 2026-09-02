import { DatabaseInterface } from './DatabaseInterface';
import { PostgresDatabase } from './LocalDatabase';
import { SupabaseDatabase } from './SupabaseDatabase';

export enum Tables {
  RELEASES = 'releases',
  RELEASES_TRACKING = 'releases_tracking',
}

export class DatabaseFactory {
  private static instance: DatabaseInterface;

  /**
   * Returns the process-wide database singleton.
   *
   * The `if (!instance)` guard is load-bearing. Without it, every call
   * constructed a new PostgresDatabase, and that constructor opens a `pg` Pool
   * which is never `.end()`ed — so each call leaked a pool. The manifest
   * endpoint calls this twice per request, which drove Aurora's connection
   * count to a peak of 81 (a single pool caps at pg's default of 10) and its
   * CPU to 100%. StorageFactory.getStorage() always had this guard; this is
   * the same shape.
   *
   * Consequence of memoizing: DB_TYPE is read once per process, so changing it
   * requires a restart rather than taking effect on the next request.
   */
  static getDatabase(): DatabaseInterface {
    if (!DatabaseFactory.instance) {
      const dbType = process.env.DB_TYPE;
      if (dbType === 'supabase') {
        DatabaseFactory.instance = new SupabaseDatabase();
      } else if (dbType === 'postgres') {
        DatabaseFactory.instance = new PostgresDatabase();
      } else {
        throw new Error('Unsupported database type');
      }
    }
    return DatabaseFactory.instance;
  }
}
