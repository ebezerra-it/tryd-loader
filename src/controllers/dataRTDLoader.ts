import Net from 'net';
import { Pool } from 'pg';
import { Logger } from 'tslog';
import { EventEmitter } from 'events';
import { sleep } from './serviceTryd';

interface IAsset {
  code: string;
  codeReplay?: string;
}

export default abstract class DataRTDLOader extends EventEmitter {
  public name: string;

  public dateRef: Date;

  public diffTime: number | undefined;

  public pool: Pool;

  public logger: Logger;

  public client: Net.Socket;

  public _bufferData: string | null;

  public _writeTimer: NodeJS.Timer | undefined;

  private host: string;

  private port: number;

  private clientCommand: string;

  private reconnectAtempts: number;

  constructor(
    name: string,
    pool: Pool,
    logger: Logger,
    host: string,
    port: number,
    dateRef?: Date,
  ) {
    super({ captureRejections: true });

    this.name = name;
    this.logger = logger;
    this.pool = pool;
    this.host = host;
    this.port = port;
    this.client = new Net.Socket();
    this.dateRef = dateRef || new Date();
    this._bufferData = null;
    this.reconnectAtempts = 0;
    this.clientCommand = '';
  }

  public abstract startListening(): void;

  public abstract loadData(chunk: Buffer): void;

  public abstract writeData(): Promise<void>;

  public abstract updateDatetimeDiff(diffTime: number): Promise<number>;

  public abstract cleanAuctionData(): Promise<number>;

  public async connect(command: string): Promise<void> {
    this.clientCommand = command;

    this.client.once('error', (err: NodeJS.ErrnoException) => {
      if (this.listenerCount('error') > 0 && err.code !== 'ECONNREFUSED')
        this.emit('error', err);
    });
    this.client.once('close', () => {
      this.reconnect();
    });
    this.client.on('data', this.loadData.bind(this));

    return new Promise<void>(resolve => {
      try {
        this.client.connect(
          {
            host: this.host,
            port: this.port,
            keepAlive: true,
            keepAliveInitialDelay:
              Number(process.env.TRYDLOADER_RTD_KEEPALIVE_INTERVAL || '5') *
              1000,
          },
          () => {
            this.reconnectAtempts = 0;
            this.logger.info(`[${this.name}] TCP connection successful`);
            this.client.write(command);

            if (this._writeTimer) clearInterval(this._writeTimer);
            const dbInterval = Number(
              process.env.TRYDLOADER_RTD_UPDATE_DATABASE_INTERVAL || '10',
            );
            this._writeTimer = setInterval(
              async () => this.writeData(),
              (dbInterval < 5 ? 5 : dbInterval) * 1000,
            );

            resolve();
          },
        );
      } catch (err) {
        this.emit('error', err);
        resolve();
      }
    });
  }

  private async reconnect(): Promise<void> {
    if (
      ++this.reconnectAtempts >=
      Number(process.env.TRYDLOADER_RTD_MAX_RECONNECT_ATEMPTS || '5')
    ) {
      if (this.listenerCount('error') > 0) {
        this.emit(
          'error',
          new Error(
            `[${this.name}] TCP connection closed. Maximum reconnect atempts reached: ${this.reconnectAtempts}`,
          ),
        );
      }
    } else {
      this.logger.warn(
        `[${this.name}] TCP connection closed. Trying to reconnect: ${
          this.reconnectAtempts
        }/${Number(process.env.TRYDLOADER_RTD_MAX_RECONNECT_ATEMPTS || '5')}`,
      );
      this.client.removeAllListeners();
      this.client.destroy();
      await sleep(Number(process.env.TRYDLOADER_RTD_RECONNECT_INTERVAL || '5'));
      await this.connect(this.clientCommand);
    }
  }

  public stopListening(): void {
    if (this._writeTimer) clearInterval(this._writeTimer);
    this.client.removeAllListeners();
    this.client.destroy();
    this.logger.warn(`[${this.name}] RTD Loader stoped`);
  }

  public parseTrydDate(trydDate: string): Date | undefined {
    /* Known formats:
      dd/mm/yyyy
      dd/mm/yyyy hh:mm:ss */
    const aFullDate = trydDate.trim().split(' ');
    let aDate;
    let aTime;
    let date: Date;
    if (aFullDate.length > 1) {
      aDate = aFullDate[0].split('/');
      aTime = aFullDate[1].split(':');
    } else {
      aDate = aFullDate[0].split('/');
    }

    if (aDate.length !== 3 && (!aTime || (!!aTime && aTime.length !== 3)))
      return undefined;

    if (aTime)
      date = new Date(
        `${aDate[2]}-${String(Number(aDate[1])).padStart(2, '0')}-${String(
          Number(aDate[0]),
        ).padStart(2, '0')} ${String(Number(aTime[0])).padStart(
          2,
          '0',
        )}:${String(Number(aTime[1])).padStart(2, '0')}:${String(
          Number(aTime[2]),
        ).padStart(2, '0')}-03`,
      );
    else
      date = new Date(
        `${aDate[2]}-${String(Number(aDate[1])).padStart(2, '0')}-${String(
          Number(aDate[0]),
        ).padStart(2, '0')} 00:00:00-03`,
      );

    if (!date || Number.isNaN(date.getTime())) return undefined;
    return date;
  }

  public isSameDay(date1: Date, date2: Date): boolean {
    return (
      date1.getFullYear() === date2.getFullYear() &&
      date1.getMonth() === date2.getMonth() &&
      date1.getDate() === date2.getDate()
    );
  }

  public getAdjustedDatetime(refDateTime: Date): Date {
    if (this.diffTime) return new Date(refDateTime.getTime() - this.diffTime);
    return refDateTime;
  }

  public calculateDiffTime(
    localDateTime: Date,
    refTime: Date,
  ): number | undefined {
    if (
      Number.isNaN(localDateTime.getTime()) ||
      Number.isNaN(refTime.getTime())
    )
      return undefined;
    return (
      localDateTime.getTime() -
      new Date(
        `${this.dateRef.getFullYear()}-${String(
          this.dateRef.getMonth() + 1,
        ).padStart(2, '0')}-${String(this.dateRef.getDate()).padStart(
          2,
          '0',
        )} ${String(refTime.getHours()).padStart(2, '0')}:${String(
          refTime.getMinutes(),
        ).padStart(2, '0')}:${String(refTime.getSeconds()).padStart(
          2,
          '0',
        )}.${String(refTime.getMilliseconds()).padStart(2, '0')}-03`,
      ).getTime()
    );
  }

  public trydFieldToDecimal(value: string): number {
    return +Number(value.replace('.', '').replace(',', '.')).toFixed(3) || 0;
  }
}

export { IAsset };
