import { Logger, ILogObject, TLogLevelName, TLogLevelId } from 'tslog';
import { readFileSync, appendFileSync } from 'fs';
import axios, { AxiosInstance } from 'axios';
import { Agent } from 'https';
import path from 'path';

class MyLogger extends Logger {
  apiBot: AxiosInstance;

  constructor(botLogger = true) {
    super({
      dateTimeTimezone: process.env.TZ || 'America/Sao_Paulo',
      dateTimePattern: 'day-month-year hour:minute:second.millisecond',
    });
    this.attachTransport(
      {
        silly: botLogger
          ? this.loggerEvent.bind(this)
          : this.logToFile.bind(this),
        debug: botLogger
          ? this.loggerEvent.bind(this)
          : this.logToFile.bind(this),
        trace: botLogger
          ? this.loggerEvent.bind(this)
          : this.logToFile.bind(this),
        info: botLogger
          ? this.loggerEvent.bind(this)
          : this.logToFile.bind(this),
        warn: botLogger
          ? this.loggerEvent.bind(this)
          : this.logToFile.bind(this),
        error: botLogger
          ? this.loggerEvent.bind(this)
          : this.logToFile.bind(this),
        fatal: botLogger
          ? this.loggerEvent.bind(this)
          : this.logToFile.bind(this),
      },
      'silly',
    );
    this.apiBot = axios.create({
      httpsAgent: new Agent({
        requestCert: true,
        ca: readFileSync(path.join(__dirname, '../../cert/web/cert.pem')),
        rejectUnauthorized: true,
        keepAlive: false,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  public async botlogEvent(logObject: ILogObject): Promise<undefined | string> {
    try {
      const res = await this.apiBot.post(
        `https://${
          (process.env.NODE_ENV === 'DEV'
            ? process.env.BOT_HOST
            : process.env.VM_HOST_IP) || 'localhost'
        }:${process.env.TELEGRAM_API_PORT || '443'}/tracelog`,
        {
          m: logObject.argumentsArray.join('\n'),
        },
      );

      if (res.status !== 200) {
        const msg = `[BOT-LOGEVENT] Can't log event due to return status code: ${res.status} - ${res.statusText}`;
        // eslint-disable-next-line no-console
        console.error(msg);
        return msg;
      }
      return undefined;
    } catch (err: any) {
      const msg = `[BOT-LOGEVENT] Can't log event due to error: ${err.message}`;
      // eslint-disable-next-line no-console
      console.error(msg);
      return msg;
    }
  }

  public logToFile(logObject: ILogObject | string): void {
    const now = new Date();
    now.setTime(now.getTime() + now.getTimezoneOffset() * 60 * 1000);

    const filename = path.resolve(
      `${__dirname}/../../${process.env.LOG_FILES_DIRECTORY || 'log'}/${
        process.env.LOG_FILES_PREFIX || ''
      }${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}.log`,
    );

    try {
      appendFileSync(filename, `${JSON.stringify(logObject)}\n`);
      return;
    } catch (err) {
      const errMsg = `[TrydLoaderAPP] SERVICE STOPPED! LOGEVENT ERROR - Could not write to log file ${filename} due to error: ${JSON.stringify(
        err,
      )}\n[LogMessage]:\n ${JSON.stringify(logObject, null, 4)}\n`;
      // eslint-disable-next-line no-console
      console.error(errMsg);
      process.stdin.emit('SIGTERM', errMsg);
    }
  }

  async loggerEvent(logObject: ILogObject): Promise<void> {
    this.logToFile(logObject);

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
    try {
      idMinLevelBotLog = <TLogLevelId>(
        tsLogLevels.indexOf(
          <TLogLevelName>(process.env.BOT_TRACELOG_MIN_LOG_LEVEL || 'error'),
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
    } catch (err: any) {
      const msg = `[BOT-LOGEVENT] Parameter TELEGRAM_TRACELOG_MIN_LOG_LEVEL with invalid content was adjusted to 'error': ${err.message}`;
      logObject.argumentsArray.push(msg);
      this.logToFile(logObject);
      this.botlogEvent(logObject);
      idMinLevelBotLog = <TLogLevelId>(
        tsLogLevels.indexOf(<TLogLevelName>'error')
      );
      process.env.BOT_TRACELOG_MIN_LOG_LEVEL = 'error';
    }

    if (logObject.logLevelId >= idMinLevelBotLog) {
      const errMsg = await this.botlogEvent(logObject);

      if (errMsg) {
        logObject.argumentsArray.push(errMsg);
        this.logToFile(logObject);
      }
    }
  }
}

export default MyLogger;
