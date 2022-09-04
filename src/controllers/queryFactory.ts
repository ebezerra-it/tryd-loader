import { Pool } from 'pg';
import { Logger } from 'tslog';
import fs from 'fs';
import path from 'path';
import { sleep } from './serviceTryd';

export default class QueryFactory {
  private pool: Pool;

  private logger: Logger;

  public closed: boolean;

  constructor(logger: Logger) {
    this.pool = new Pool({
      host: process.env.DB_HOST || '',
      port: Number(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || '',
      user: process.env.DB_USER || '',
      password: process.env.DB_PASS || '',
      ssl: {
        rejectUnauthorized: false,
        ca: fs
          .readFileSync(path.join(__dirname, '../../', 'ssl/ca.crt'))
          .toString(),
      },
    });

    this.closed = false;

    this.logger = logger;
  }

  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  public async query(sql: any, params?: any[]): Promise<any> {
    let tries = 0;
    let queryResult: any;
    let error: any;
    const maxTries = Number(process.env.QUERY_RETRIES || '0');
    while (tries++ <= (maxTries < 0 ? 0 : maxTries)) {
      try {
        queryResult = await this.pool.query({ text: sql, values: params });
        break;
      } catch (err) {
        error = err;
        this.logger.warn(
          `[QueryFactory] Query() - exception thrown in query - Try: ${tries}/${maxTries} - Error: ${error.message}`,
        );
        await sleep(Number(process.env.QUERY_RETRY_INTERVAL || '0'));
      }
    }

    if (error)
      throw new Error(
        `[QueryFactory] Query() - exception thrown in query - Maximum retries reached - Error: ${JSON.stringify(
          error,
        )}`,
      );
    return queryResult;
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.pool.end();
  }
}
