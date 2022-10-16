import { Logger, ILogObject, TLogLevelName, TLogLevelId } from 'tslog';
import { Pool } from 'pg';
import path from 'path';
import fs from 'fs';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import dotenv from 'dotenv';
import { exec } from 'child_process';
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
    ca: fs.readFileSync(path.join(__dirname, '../', 'ssl/ca.crt')).toString(),
  },
});

let serviceTryd: ServiceTryd;
let deleted = 0;
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
    text: `SELECT * FROM "global-parameters" WHERE key LIKE 'TRYDLOADER_%' ORDER BY key ASC`,
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
    text: `SELECT COUNT(*) inserted FROM "b3-brokers" WHERE datetime=$1::DATE`,
    values: [new Date()],
  });

  const result: { inserted: number; deleted: number } = {
    inserted: qRes.rows[0].inserted,
    deleted,
  };
  await pool.query({
    text: `UPDATE "loadcontrol" SET status=$3, result=$4, "finished-at"=NOW() 
    WHERE "date-ref"::DATE=$1::DATE AND process=$2`,
    values: [new Date(), 'TrydLoaderStarter', 'DONE', result],
  });

  if (serviceTryd) await serviceTryd.stop();
  if (pool) await pool.end();
  if (process.env.NODE_ENV === 'PROD') exec('shutdown /s /t 0');
};

(async () => {
  const logger = new Logger({
    dateTimeTimezone: process.env.TZ || 'America/Sao_Paulo',
    dateTimePattern: 'day-month-year hour:minute:second.millisecond',
  });

  const log2File = (logObject: ILogObject | string): void => {
    const filename = path.resolve(
      `${__dirname}/../${process.env.LOG_FILES_DIRECTORY || 'log'}/${
        process.env.LOG_FILES_PREFIX || ''
      }${dayjs().format('YYYYMM')}.log`,
    );

    try {
      fs.appendFileSync(filename, `${JSON.stringify(logObject)}\n`);
      return;
    } catch (err) {
      const errMsg = `[TrydLoaderAPP] SERVICE STOPED! LOGEVENT ERROR - Could not write to log file ${filename} due to error: ${JSON.stringify(
        err,
      )}\n[LogMessage]:\n ${JSON.stringify(logObject, null, 4)}\n`;
      // eslint-disable-next-line no-console
      console.error(errMsg);
      process.stdin.emit('SIGTERM', errMsg);
    }
  };

  const botLogEvent = async (event: string): Promise<void> => {
    try {
      const url = `http://${process.env.VM_HOST_IP || '127.0.0.1'}:${
        process.env.TELEGRAM_API_PORT || '8001'
      }/tracelog`;

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          m: event,
        }),
      });

      if (!res.ok || res.status !== 200) {
        log2File(
          `[TrydLoaderAPP] Can't log event due to BOT-API return status code: ${res.status} - ${res.statusText}`,
        );
      }
    } catch (err) {
      log2File(
        `[TrydLoaderAPP] Can't log event due to error: ${JSON.stringify(err)}`,
      );
    }
  };

  await pool.query({
    text: `INSERT INTO "global-parameters" (key, value, "lastupdate-user", "lastupdate-ts") VALUES ('TRYDLOADER_RUN_SERVICE', 'TRUE', -1, NOW()) ON CONFLICT (key) DO UPDATE SET value='TRUE', "lastupdate-user"=-1, "lastupdate-ts"=NOW()`,
  });

  try {
    await loadParameters();
  } catch (err) {
    const errMsg = `[TrydLoaderAPP] Can't start service due to error: ${JSON.stringify(
      err,
      null,
      4,
    )}`;

    log2File(errMsg);
    await botLogEvent(errMsg);

    await terminate();
    return;
  }

  const logEvent = async (logObject: ILogObject): Promise<void> => {
    log2File(logObject);

    const tsLogLevels: TLogLevelName[] = [
      'silly',
      'trace',
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
    ];

    let idMinLevelBotLog: TLogLevelId;

    if (
      !tsLogLevels.find(
        l =>
          String(l) ===
          (process.env.TRYDLOADER_BOTLOG_MIN_LOG_LEVEL || 'error'),
      )
    ) {
      idMinLevelBotLog = <TLogLevelId>(
        tsLogLevels.indexOf(<TLogLevelName>'error')
      );
    } else {
      idMinLevelBotLog = <TLogLevelId>(
        tsLogLevels.indexOf(
          <TLogLevelName>(
            (process.env.TRYDLOADER_BOTLOG_MIN_LOG_LEVEL || 'error')
          ),
        )
      );

      // MIN_LOG_LEVEL = 'info'
      if (
        idMinLevelBotLog <
        <TLogLevelId>tsLogLevels.indexOf(<TLogLevelName>'info')
      )
        idMinLevelBotLog = <TLogLevelId>(
          tsLogLevels.indexOf(<TLogLevelName>'info')
        );
    }

    if (logObject.logLevelId >= idMinLevelBotLog)
      await botLogEvent(
        JSON.stringify(logObject.argumentsArray.join('\n'), null, 4),
      );
  };

  logger.attachTransport(
    {
      silly: logEvent,
      debug: logEvent,
      trace: logEvent,
      info: logEvent,
      warn: logEvent,
      error: logEvent,
      fatal: logEvent,
    },
    'info',
  );

  // check if service started after shutdown time
  if (process.env.TRYDLOADER_SHUTDOWN_TIME) {
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

  // check if service started after shutdown time
  if (process.env.TRYDLOADER_SHUTDOWN_TIME) {
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
  if (dayjs().day() === 0 || dayjs().day() === 6) isTradeDay = false;
  else {
    // check for holidays
    const qHolidays = await pool.query({
      text: `SELECT event from "holiday-calendar" WHERE "country-code"=$1 AND date::DATE=$2::DATE`,
      values: ['BR', dayjs().startOf('day')],
    });
    if (qHolidays.rowCount > 0) {
      try {
        const calendarExceptions: { country: string; exceptions: string[] }[] =
          JSON.parse(process.env.CALENDAR_HOLIDAY_EXCEPTIONS || '');

        /* console.log(
          `CALENDAR_EXCEPTIONS=${JSON.stringify(calendarExceptions)}`,
        ); */
        if (calendarExceptions) {
          const b3Exceptions = calendarExceptions.find(c => c.country === 'BR');
          if (
            b3Exceptions &&
            !b3Exceptions.exceptions.find(e =>
              qHolidays.rows.find(
                (q: any) =>
                  String(q.event).trim().toUpperCase() ===
                  e.trim().toUpperCase(),
              ),
            )
          ) {
            isTradeDay = false;
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
      `[TrydLoaderAPP] Service weekend/holiday programmed stop: ${dayjs()
        .startOf('day')
        .format('DD/MM/YYYY')}`,
    );

    await terminate();
    return;
  }

  updateParameters = setInterval(async () => {
    await loadParameters();

    if (
      String(process.env.TRYDLOADER_RUN_SERVICE || '')
        .trim()
        .toUpperCase() === 'FALSE'
    )
      return;

    // check if shutdown time reached
    if (process.env.TRYDLOADER_SHUTDOWN_TIME) {
      const dtSch = dayjs(
        `${dayjs().format('YYYY-MM-DD')} ${
          process.env.TRYDLOADER_SHUTDOWN_TIME
        }`,
        'YYYY-MM-DD HH:mm',
      );
      if (dtSch.isValid() && dtSch.isBefore(dayjs())) {
        if (updateParameters) clearInterval(updateParameters);
        process.env.TRYDLOADER_RUN_SERVICE = 'FALSE';
        logger.warn(
          `[TrydLoaderAPP] Service time programmed stop: ${process.env.TRYDLOADER_SHUTDOWN_TIME}`,
        );
      }
    }
  }, Number(process.env.TRYDLOADER_UPDATE_PARAMETERS_INTERVAL || '30') * 1000);

  if (
    String(process.env.TRYDLOADER_RUN_SERVICE || '')
      .trim()
      .toUpperCase() === 'TRUE'
  ) {
    serviceTryd = new ServiceTryd(pool, logger, botLogEvent);
    serviceTryd.on('error', err => {
      if (updateParameters) clearInterval(updateParameters);

      logger.error(
        `[TrydLoaderAPP] Could not start service due to error: ${JSON.stringify(
          err,
          null,
          4,
        )}`,
      );
      process.env.TRYDLOADER_RUN_SERVICE = 'FALSE';
    });

    /* let resDel: QueryResult | null = await pool.query({
      text: `WITH del as (DELETE FROM "b3-brokersbalance" WHERE datetime=$1::DATE RETURNING *) SELECT COUNT(*) deleted FROM del`,
      values: [new Date()],
    });
    deleted = Number(resDel.rows[0].deleted);
    resDel = null; */
    deleted = 0;

    await serviceTryd.start();
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
