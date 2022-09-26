import { Logger, ILogObject, TLogLevelName, TLogLevelId } from 'tslog';
import path from 'path';
import fs from 'fs';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import axios from 'axios';
import qs from 'qs';
import dotenv from 'dotenv';
import { exec } from 'child_process';
import ServiceTryd, { sleep } from './controllers/serviceTryd';
import QueryFactory from './controllers/queryFactory';

if (String(process.env.NODE_ENV === 'PROD'))
  dotenv.config({ path: './prod.env' });
else dotenv.config({ path: './.env' });

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault(process.env.TZ || 'America/Sao_Paulo');
dayjs.extend(customParseFormat);

let queryFactory: QueryFactory;

let serviceTryd: ServiceTryd;

const loadParameters = async (): Promise<void> => {
  if (
    String(process.env.TRYDLOADER_RUN_SERVICE || '')
      .trim()
      .toUpperCase() === 'FALSE'
  )
    return;

  const qParams = await queryFactory.query({
    sql: `SELECT * FROM "global-parameters" WHERE key LIKE 'TRYDLOADER_%' ORDER BY key ASC`,
  });

  if (!qParams || qParams.rowCount === 0)
    throw new Error(`Unable to load TRYDLOADER_ global parameters`); // Check try catch

  qParams.rows.forEach((param: any) => {
    process.env[param.key] = param.value;
  });
};

let updateParameters: NodeJS.Timer;

const terminate = async (): Promise<void> => {
  if (updateParameters) clearInterval(updateParameters);

  // wait for any running loadParameter() process to finish
  await sleep(
    Number(process.env.TRYDLOADER_UPDATE_PARAMETERS_INTERVAL || '30'),
  );

  if (serviceTryd) await serviceTryd.stop();
  if (queryFactory && !queryFactory.closed) await queryFactory.close();
  process.stdin.emit('SIGTERM', `[TrydLoader] Service stoped`);
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
      const res = await axios.post(
        `http://${process.env.VM_HOST_IP || '127.0.0.1'}:${
          process.env.TELEGRAM_API_PORT || '8001'
        }/tracelog`,
        qs.stringify({
          m: event,
        }),
      );
      if (res.status !== 200) {
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

  queryFactory = new QueryFactory(logger);
  await queryFactory.query({
    sql: `INSERT INTO "global-parameters" (key, value, "lastupdate-user", "lastupdate-ts") VALUES ('TRYDLOADER_RUN_SERVICE', 'TRUE', -1, NOW()) ON CONFLICT (key) DO UPDATE SET value='TRUE', "lastupdate-user"=-1, "lastupdate-ts"=NOW()`,
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

  updateParameters = setInterval(async () => {
    loadParameters();

    if (
      String(process.env.TRYDLOADER_RUN_SERVICE || '')
        .trim()
        .toUpperCase() === 'FALSE'
    )
      return;

    if (process.env.TRYDLOADER_SHUTDOWN_TIME) {
      const dtSch = dayjs(
        `${dayjs().format('YYYY-MM-DD')} ${
          process.env.TRYDLOADER_SHUTDOWN_TIME
        }`,
        'YYYY-MM-DD HH:mm',
      );
      if (dtSch.isValid() && dtSch.isBefore(dayjs())) {
        await queryFactory.query({
          sql: `INSERT INTO "global-parameters" (key, value, "lastupdate-user", "lastupdate-ts") VALUES ('TRYDLOADER_RUN_SERVICE', 'FALSE', -1, NOW()) ON CONFLICT (key) DO UPDATE SET value='FALSE', "lastupdate-user"=-1, "lastupdate-ts"=NOW()`,
        });
        process.env.TRYDLOADER_RUN_SERVICE = 'FALSE';
        logger.warn(
          `[TrydLoaderAPP] Service time programmed stop: ${process.env.TRYDLOADER_SHUTDOWN_TIME}`,
        );
      }
    }
  }, Number(process.env.TRYDLOADER_UPDATE_PARAMETERS_INTERVAL || '30') * 1000);

  // Check if is trade day
  let isTradeDay = true;
  if (dayjs().day() === 0 || dayjs().day() === 6) isTradeDay = false;
  else {
    // check for holidays
    const qHolidays = await queryFactory.query({
      sql: `SELECT event from "holiday-calendar" WHERE "country-code"=$1 AND date::DATE=$2::DATE`,
      params: ['BR', dayjs().startOf('day')],
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
    logger.warn(
      `[TrydLoaderAPP] Service weekend/holiday programmed stop: ${dayjs()
        .startOf('day')
        .format('DD/MM/YYYY')}`,
    );
    await queryFactory.query({
      sql: `INSERT INTO "global-parameters" (key, value, "lastupdate-user", "lastupdate-ts") VALUES ('TRYDLOADER_RUN_SERVICE', 'FALSE', -1, NOW()) ON CONFLICT (key) DO UPDATE SET value='FALSE', "lastupdate-user"=-1, "lastupdate-ts"=NOW()`,
    });
    await terminate();
    return;
  }

  // wait for update parameters to run to check shutdown time before starting service
  await sleep(
    Number(process.env.TRYDLOADER_UPDATE_PARAMETERS_INTERVAL || '30') +
      Math.trunc(
        Number(process.env.TRYDLOADER_UPDATE_PARAMETERS_INTERVAL || '30') / 2,
      ),
  );
  serviceTryd = new ServiceTryd(queryFactory, logger, botLogEvent);

  try {
    if (
      String(process.env.TRYDLOADER_RUN_SERVICE || '')
        .trim()
        .toUpperCase() === 'TRUE'
    ) {
      await serviceTryd.start();
    }
  } catch (err) {
    clearInterval(updateParameters);

    logger.error(
      `[TrydLoaderAPP] Could not start service due to error: ${JSON.stringify(
        err,
        null,
        4,
      )}`,
    );

    await terminate();
    return;
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
