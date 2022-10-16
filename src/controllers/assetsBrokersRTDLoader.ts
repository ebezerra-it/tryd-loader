import Net from 'net';
import { Pool } from 'pg';
import format from 'pg-format';
import { Logger } from 'tslog';
import { EventEmitter } from 'events';
import { sleep } from './trydHandler';

interface IBroker {
  id: number;
  active: boolean;
  volume: number;
  vwap: number;
}

interface IAssetsBrokersBalance {
  asset: string;
  brokersBalance: IBroker[];
}

let _assetsBrokersBalance: IAssetsBrokersBalance[];

let _bufferData: string | null;

export default class AssetsBrokersRTDLoader extends EventEmitter {
  private pool: Pool;

  private logger: Logger;

  private host: string;

  private port: number;

  private client: Net.Socket;

  private _writeTimer: NodeJS.Timer | undefined;

  private loadData = (chunk: Buffer) => {
    if (chunk.length <= 0) return;

    let data: string | null = chunk.toString('utf-8');

    data = (_bufferData || '').concat(data);
    _bufferData = null;

    if (data.substr(data.length - 1, 1) !== '#') {
      const posLastLine = data.lastIndexOf('|');
      if (posLastLine < 0) throw new Error('');

      _bufferData = (_bufferData || '').concat(data.substring(posLastLine + 1));
      data = data.substring(0, posLastLine);

      if (data.substr(0, 4) === 'RNK!') data = data.substr('RNK!'.length); // Removes 'RNK!' at begining
    } else {
      data =
        data.substr(0, 4) === 'RNK!'
          ? data.substr('RNK!'.length, data.length - ('RNK!'.length + 1))
          : data.substr(0, data.length - 1); // Removes 'RNK!' at begining and '#' at end

      _bufferData = null;
    }

    data
      .replace(/#RNK!/g, '|')
      .split('|')
      .forEach(line => {
        const columns = line.split(';');
        if (
          columns.length !== 5 ||
          Number.isNaN(columns[1]) ||
          (columns[3] !== 'Qtd' && columns[3] !== 'Prc')
        )
          throw new Error(
            `[AssetsBrokerRTDLoader] Unknown data line format: ${line}`,
          );

        const posAssetBrokers = _assetsBrokersBalance
          .map(a => a.asset)
          .indexOf(columns[0].toUpperCase());

        if (posAssetBrokers < 0)
          throw new Error(`[AssetsBrokerRTDLoader] Unknown asset: ${line}`);

        const posBroker = _assetsBrokersBalance[posAssetBrokers].brokersBalance
          .map(b => b.id)
          .indexOf(Number(columns[1]));

        if (posBroker < 0)
          throw new Error(`[AssetsBrokerRTDLoader] Unknown broker: ${line}`);

        if (columns[3] === 'Qtd')
          _assetsBrokersBalance[posAssetBrokers].brokersBalance[
            posBroker
          ].volume = Number(columns[4]) || 0;
        else
          _assetsBrokersBalance[posAssetBrokers].brokersBalance[
            posBroker
          ].vwap = Number(columns[4].replace(',', '.')) || 0;

        if (
          _assetsBrokersBalance[posAssetBrokers].brokersBalance[posBroker]
            .vwap > 0 ||
          _assetsBrokersBalance[posAssetBrokers].brokersBalance[posBroker]
            .volume > 0
        )
          _assetsBrokersBalance[posAssetBrokers].brokersBalance[
            posBroker
          ].active = true;
      });

    data = null;
  };

  private updateDatabase = async (pool: Pool) => {
    const insertParams: any[] = [];
    const now = new Date();

    // eslint-disable-next-line no-restricted-syntax
    for await (const a of _assetsBrokersBalance) {
      try {
        const qLast = await pool.query({
          text: `SELECT distinct on ("broker-id") "broker-id" brokerid, datetime, volume, vwap FROM "b3-brokersbalance" WHERE asset=$1 AND datetime::DATE=NOW()::DATE ORDER BY "broker-id" ASC, datetime DESC`,
          values: [a.asset],
        });

        a.brokersBalance.forEach(b => {
          if (b.active) {
            const posLastBroker = qLast.rows
              .map(q => Number(q.brokerid))
              .indexOf(b.id);
            if (
              posLastBroker < 0 ||
              (posLastBroker >= 0 &&
                (b.volume !== Number(qLast.rows[posLastBroker].volume) ||
                  b.vwap !== Number(qLast.rows[posLastBroker].vwap)))
            )
              insertParams.push([now, a.asset, b.id, b.volume, b.vwap]);
          }
        });
      } catch (err) {
        throw new Error(
          `[AssetsBrokerRTDLoader] Exception thrown when trying to select data from database for Asset: ${
            a.asset
          } - Error: ${JSON.stringify(err)}`,
        );
      }
    }
    if (insertParams.length === 0) return;

    try {
      await pool.query(
        format(
          'INSERT INTO "b3-brokersbalance" (datetime, asset, "broker-id", volume, vwap) VALUES  %L',
          insertParams,
        ),
        [],
      );
    } catch (err) {
      throw new Error(
        `[AssetsBrokerRTDLoader] Exception thrown when trying to insert data into database - Error: ${JSON.stringify(
          err,
        )}\n\nINSERT-PARAMS=${JSON.stringify(insertParams)}`,
      );
    }
  };

  constructor(
    pool: Pool,
    logger: Logger,
    host: string,
    port: number,
    assetsBrokersBalance: IAssetsBrokersBalance[],
  ) {
    super({ captureRejections: true });

    this.logger = logger;
    this.pool = pool;
    this.host = host;
    this.port = port;
    this.client = new Net.Socket();

    _assetsBrokersBalance = assetsBrokersBalance;
    _bufferData = null;
  }

  public startListening(): void {
    this.openRTDConnection();
  }

  private openRTDConnection() {
    this.client.removeAllListeners();
    if (this._writeTimer) clearInterval(this._writeTimer);

    this.client.on('error', err => {
      this.emit(
        'error',
        new Error(
          `[AssetsBrokerRTDLoader] Exception thrown on RTD client host: ${
            this.host
          }:${this.port} - Error: ${JSON.stringify(err)}`,
        ),
      );
    });

    this.client.connect(
      {
        host: this.host,
        port: this.port,
        keepAlive: true,
        keepAliveInitialDelay:
          Number(process.env.TRYDLOADER_RTD_KEEPALIVE_INTERVAL || '5') * 1000,
      },
      () => {
        this.client.removeAllListeners('close');
        this.client.removeAllListeners('end');
        this.client.removeAllListeners('data');

        this.logger.info(`[AssetsBrokerRTDLoader] RTD connection succeeded.`);

        const itens: string[] = [];
        _assetsBrokersBalance.forEach(a => {
          a.brokersBalance.forEach(b => {
            itens.push(`RNK$S|${a.asset}|${b.id}|7|Qtd`);
            itens.push(`RNK$S|${a.asset}|${b.id}|7|Prc`);
          });
        });
        if (itens.length === 0)
          throw new Error(
            `[AssetsBrokerRTDLoader] Can't initiate with empty itens list.\n\nASSETS_BROKERS_BALANCE=${JSON.stringify(
              _assetsBrokersBalance,
            )}`,
          );

        // TO DO: Test RTD disconnection event firing twice 'CLOSE' and 'END'
        this.client.once('close', async () => {
          this.logger.warn(
            `[AssetsBrokerRTDLoader] RTD connection closed. Trying to reconnect...`,
          );
          await sleep(
            Number(process.env.TRYDLOADER_RTD_RECONNECT_INTERVAL || '5'),
          );
          this.openRTDConnection();
        });

        this.client.once('end', async () => {
          this.logger.warn(
            `[AssetsBrokerRTDLoader] RTD connection ended. Trying to reconnect...`,
          );
          await sleep(
            Number(process.env.TRYDLOADER_RTD_RECONNECT_INTERVAL || '5'),
          );
          this.openRTDConnection();
        });

        this.client.on('data', this.loadData);

        this.client.write(itens.join('#'));

        const dbInterval = Number(
          process.env.TRYDLOADER_UPDATE_DATABASE_INTERVAL || '5',
        );
        this._writeTimer = setInterval(
          async (pool: Pool) => this.updateDatabase(pool),
          (dbInterval < 5 ? 5 : dbInterval) * 1000,
          this.pool,
        );
      },
    );
  }

  public stopListening(): void {
    if (this._writeTimer) clearInterval(this._writeTimer);
    this.client.removeAllListeners();
    this.client.destroy();
    this.removeAllListeners();
  }
}

export { IBroker, IAssetsBrokersBalance };
