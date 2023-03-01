import { Pool, QueryResult } from 'pg';
import path from 'path';
import fs from 'fs';
import dayjs, { Dayjs } from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import dotenv from 'dotenv';
import { exec } from 'child_process';
import MyLogger from './controllers/myLogger';
import ServiceTryd, { sleep } from './controllers/serviceTryd';

dotenv.config({ path: path.resolve(__dirname, '../', '.env') });

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault(process.env.TZ || 'America/Sao_Paulo');
dayjs.extend(customParseFormat);

const pool = new Pool({
  host: process.env.VM_HOST_IP || '',
  port: Number(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || '',
  user: process.env.DB_USER || '',
  password: process.env.DB_PASS || '',
  ssl: {
    rejectUnauthorized: false,
    ca: fs
      .readFileSync(path.join(__dirname, '../', '/cert/db', 'root.crt'))
      .toString(),
    key: fs
      .readFileSync(path.join(__dirname, '../', '/cert/db', 'client.key'))
      .toString(),
    cert: fs
      .readFileSync(path.join(__dirname, '../', '/cert/db', 'client.crt'))
      .toString(),
  },
});

let serviceTryd: ServiceTryd;
let deleted = 0;

const dateRef: Dayjs =
  process.argv.length > 2 ? dayjs(process.argv[2], 'DD/MM/yyyy') : dayjs();

// C:\Tryd6\trader.exe --launcher.appendVmargs -vmargs -DReplayFilePathToPlayback=C%3A%5CTryd6%5Cworkspace%5Creplay%5Cimport%5CACOES%5Ctryd_replay_20221014.0.gz
// C:\Tryd6\trader.exe --launcher.appendVmargs -vmargs -DReplayFilePathToPlayback=C:\Tryd6\workspace\replay\import\ACOES\tryd_replay_20221014.0.gz
const loadParameters = async (): Promise<void> => {
  if (
    String(process.env.TRYDLOADER_RUN_SERVICE || '')
      .trim()
      .toUpperCase() === 'FALSE'
  )
    return;

  const qParams = await pool.query({
    text: `SELECT * FROM "global-parameters" WHERE (key = ANY($1) OR key LIKE 'TRYDLOADER_%') AND NOT key = ANY($2) ORDER BY key ASC`,
    values: [
      ['CALENDAR_HOLIDAY_EXCEPTIONS', 'BOT_TRACELOG_MIN_LOG_LEVEL'], // includes
      ['TRYDLOADER_RUN_SERVICE'], // excludes
    ],
  });

  if (!qParams || qParams.rowCount === 0)
    throw new Error(`Unable to load "TRYDLOADER_*" global parameters`); // Check try catch

  qParams.rows.forEach((param: any) => {
    process.env[param.key] = param.value;
  });
};

let updateParameters: NodeJS.Timer | undefined;

const terminate = async (): Promise<void> => {
  if (updateParameters) clearInterval(updateParameters);

  const qRes = await pool.query({
    text: `SELECT q1.inserted+q2.inserted+q3.inserted inserted FROM
    (SELECT COUNT(*) inserted FROM "b3-assetsbrokers" WHERE datetime::DATE=$1::DATE) q1,
    (SELECT COUNT(*) inserted FROM "b3-assetsquotes" WHERE datetime::DATE=$1::DATE) q2,
    (SELECT COUNT(*) inserted FROM "b3-assetsbooks" WHERE datetime::DATE=$1::DATE) q3`,
    values: [dateRef.toDate()],
  });

  const result: { inserted: number; deleted: number } = {
    inserted: qRes.rows[0].inserted,
    deleted,
  };
  await pool.query({
    text: `UPDATE "loadcontrol" SET status=$3, result=$4, "finished-at"=$5 
    WHERE "date-ref"::DATE=$1::DATE AND process=$2`,
    values: [dateRef.toDate(), 'TrydLoaderStarter', 'DONE', result, new Date()],
  });

  if (serviceTryd) await serviceTryd.stop();
  if (pool) await pool.end();
  if (process.env.NODE_ENV === 'PROD') exec('shutdown /s /t 0');
};

(async () => {
  const logger = new MyLogger();

  if (!dateRef.isValid()) {
    logger.error(
      `[TrydLoaderAPP] ERROR - Invalid reference date: ${process.argv[2]}`,
    );
    terminate();
    return;
  }

  // Enable RUN_SERVICE control flag
  await pool.query({
    text: `INSERT INTO "global-parameters" (key, value, "lastupdate-user", "lastupdate-ts") VALUES ('TRYDLOADER_RUN_SERVICE', 'TRUE', -1, $1) ON CONFLICT (key) DO UPDATE SET value='TRUE', "lastupdate-user"=-1, "lastupdate-ts"=$1`,
    values: [new Date()],
  });
  process.env.TRYDLOADER_RUN_SERVICE = 'TRUE';

  try {
    await loadParameters();
  } catch (err) {
    const errMsg = `[TrydLoaderAPP] Can't start service due to error: ${JSON.stringify(
      err,
      null,
      4,
    )}`;

    logger.fatal(errMsg);

    await terminate();
    return;
  }

  // check if service started after shutdown time
  if (
    dateRef.startOf('day').isSame(dayjs().startOf('day')) &&
    String(process.env.TRYDLOADER_SHUTDOWN_TIME) !== ''
  ) {
    const dtSch = dayjs(
      `${dayjs().format('YYYY-MM-DD')} ${process.env.TRYDLOADER_SHUTDOWN_TIME}`,
      'YYYY-MM-DD HH:mm',
    );
    if (dtSch.isValid() && dtSch.isBefore(dayjs())) {
      process.env.TRYDLOADER_RUN_SERVICE = 'FALSE';
      logger.warn(
        `[TrydLoaderAPP] Service won't innitiate after programmed stop time: ${process.env.TRYDLOADER_SHUTDOWN_TIME}`,
      );
      await terminate();
      return;
    }
  }

  // Check if is trade day
  let isTradeDay = true;
  let weekendholiday = '';
  if (dateRef.day() === 0 || dateRef.day() === 6) {
    weekendholiday = dateRef.format('dddd');
    isTradeDay = false;
  } else {
    // check for holidays
    const qHolidays = await pool.query({
      text: `SELECT event from "holiday-calendar" WHERE "country-code"=$1 AND date::DATE=$2::DATE`,
      values: ['BR', dateRef.startOf('day')],
    });
    if (qHolidays.rowCount > 0) {
      isTradeDay = false;
      weekendholiday = qHolidays.rows[0].event;
      try {
        const calendarExceptions: { country: string; exceptions: string[] }[] =
          JSON.parse(process.env.CALENDAR_HOLIDAY_EXCEPTIONS || '');

        if (calendarExceptions) {
          const b3Exceptions = calendarExceptions.find(c => c.country === 'BR');
          if (
            b3Exceptions &&
            !!b3Exceptions.exceptions.find(e =>
              qHolidays.rows.find(
                (q: any) =>
                  String(q.event).trim().toUpperCase() ===
                  e.trim().toUpperCase(),
              ),
            )
          ) {
            logger.warn(
              `[TrydLoaderAPP] Identified holiday exception: ${weekendholiday}`,
            );
            isTradeDay = true;
          }
        }
        // eslint-disable-next-line no-empty
      } catch (e) {
        logger.warn(
          `[TrydLoaderAPP] Holiday exceptions type missmatch error: ${process.env.CALENDAR_HOLIDAY_EXCEPTIONS}`,
        );
        isTradeDay = false;
      }
    }
  }

  if (!isTradeDay) {
    if (updateParameters) clearInterval(updateParameters);
    logger.warn(
      `[TrydLoaderAPP] Service weekend/holiday programmed stop: ${dateRef.format(
        'DD/MM/YYYY',
      )} [${weekendholiday}]`,
    );

    await terminate();
    return;
  }

  updateParameters = setInterval(async () => {
    await loadParameters();
  }, Number(process.env.TRYDLOADER_UPDATE_PARAMETERS_INTERVAL || '30') * 1000);

  if (
    String(process.env.TRYDLOADER_RUN_SERVICE || '')
      .trim()
      .toUpperCase() === 'TRUE'
  ) {
    await sleep(10);
    serviceTryd = new ServiceTryd(pool, logger, dateRef.toDate());
    serviceTryd.once('error', err => {
      if (updateParameters) clearInterval(updateParameters);

      logger.error(
        `[TrydLoaderAPP] Exception thrown: ${JSON.stringify(err, null, 4)}`,
      );
      process.env.TRYDLOADER_RUN_SERVICE = 'FALSE';
    });

    deleted = 0;
    if (!dateRef.startOf('day').isSame(dayjs().startOf('day'))) {
      let resDel: QueryResult | null;
      resDel = await pool.query({
        text: `WITH del as (DELETE FROM "b3-assetsbrokers" WHERE datetime::DATE=$1::DATE OR auction=TRUE RETURNING *) SELECT COUNT(*) deleted FROM del`,
        values: [dateRef.toDate()],
      });
      deleted += Number(resDel.rows[0].deleted);
      resDel = await pool.query({
        text: `WITH del as (DELETE FROM "b3-assetsbrokers" WHERE datetime::DATE=$1::DATE OR auction=TRUE RETURNING *) SELECT COUNT(*) deleted FROM del`,
        values: [dateRef.toDate()],
      });
      deleted += Number(resDel.rows[0].deleted);
      resDel = await pool.query({
        text: `WITH del as (DELETE FROM "b3-assetsbooks" WHERE datetime::DATE=$1::DATE OR auction=TRUE RETURNING *) SELECT COUNT(*) deleted FROM del`,
        values: [dateRef.toDate()],
      });
      deleted += Number(resDel.rows[0].deleted);
      resDel = null;
    }

    serviceTryd.start();
  }

  while (
    String(process.env.TRYDLOADER_RUN_SERVICE || '')
      .trim()
      .toUpperCase() === 'TRUE'
  ) {
    await sleep(
      Number(process.env.TRYDLOADER_SERVICE_CHECK_RUNNING_INTERVAL || '10'),
    );
  }

  await terminate();
})();
