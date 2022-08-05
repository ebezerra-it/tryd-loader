/* eslint-disable camelcase */
/* eslint-disable no-restricted-syntax */
import fs from 'fs';
import { Logger } from 'tslog';
import { Pool } from 'pg';
import dayjs, { Dayjs } from 'dayjs';
import TrydHandler, { sleep } from './trydHandler';
import BrokersDDELoader from './brokersDDELoader';

interface IBroker {
  id: number;
  name: string;
  exchange_bmf: boolean;
  exchange_bov: boolean;
}

enum TExchange {
  BMF = 'BMF',
  BOV = 'BOV',
}

interface IAsset {
  code: string;
  exchange: TExchange;
}

interface IFutureContract {
  code: string;
  expiry: Dayjs;
}

export default class ServiceTryd {
  private logger: Logger;

  private botLogger: (event: string) => Promise<void>;

  private tryd: TrydHandler;

  private assetsBrokersLoader: BrokersDDELoader[];

  private pool: Pool;

  constructor(
    pool: Pool,
    logger: Logger,
    botLogger: (event: string) => Promise<void>,
  ) {
    this.tryd = new TrydHandler();
    this.assetsBrokersLoader = [];
    this.logger = logger;
    this.botLogger = botLogger;
    this.pool = pool;
  }

  public async start(): Promise<void> {
    const assets = await this.getAssets();
    if (assets.length === 0)
      throw new Error(
        `[ServiceTryd] Unable to start service with empty asset list`,
      );

    const brokers = await this.getTrydBrokers();
    if (brokers.length === 0) throw new Error(`Empty brokers is not allowed`);

    assets.forEach(asset => {
      this.assetsBrokersLoader.push(
        new BrokersDDELoader(
          this.pool,
          asset.code,
          brokers.filter(b => {
            if (asset.exchange === TExchange.BMF) return b.exchange_bmf;
            return b.exchange_bov;
          }),
        ),
      );
    });

    this.tryd.on('ConnectionBroken', () => {
      this.logger.warn(`[ServiceTryd] ALERT: Tryd connection is down!`);
    });

    await sleep(Number(process.env.TRYDLOADER_SERVICE_START_DELAY || '30')); // wait for OS ready

    await this.tryd.open();
    await this.tryd.startDataListening();

    try {
      this.startAssetsDDEListening();
      this.logger.info(`[ServiceTryd] Loading process started`);
    } catch (err) {
      throw new Error(`Loading process failed to start: ${err.message}`);
    }
  }

  private startAssetsDDEListening(): void {
    for (const assetBroker of this.assetsBrokersLoader) {
      assetBroker.startListening();
    }
  }

  public async stop(): Promise<void> {
    await this.stopAssetsDDEListening();
    await this.tryd.close();
    this.logger.info(`[ServiceTryd] Process stoped`);
  }

  private async stopAssetsDDEListening(): Promise<void> {
    for await (const assetBroker of this.assetsBrokersLoader) {
      await assetBroker.stopListening();
    }
  }

  private async getAssets(): Promise<IAsset[]> {
    const assets: IAsset[] = [];

    const aBmf = (process.env.TRYDLOADER_ASSETS_BMF || '')
      .split(',')
      .map(a =>
        a
          .trim()
          .toUpperCase()
          .replace(/^(.*)((FUT)|((F|G|H|J|K|M|N|Q|U|V|X|Z)\d\d))$/, '$1$$1'),
      )
      .filter(a => a !== '');
    const aBov = (process.env.TRYDLOADER_ASSETS_BOV || '')
      .split(',')
      .map(a => a.trim().toUpperCase())
      .filter(a => a !== '');

    if (aBmf.length === 0 && aBov.length === 0) return assets;

    // Check if BMF asset exists and treat futures contract $1/FUT=>current contract; $2=>next contract
    for await (const [index, asset] of aBmf.entries()) {
      const contracts = await this.getFuturesContract(
        asset.replace(/\$[1|2]/, ''),
      );

      if (!contracts || (asset.indexOf('$2') && !contracts.next)) {
        this.logger.warn(`[ServiceTryd] BMF asset not recognized: ${asset}`);
        aBmf.splice(index, 1);
      } else {
        assets.push({
          code: asset
            .replace('$1', contracts.current.code)
            .replace('$2', contracts.next ? contracts.next.code : ''),
          exchange: TExchange.BMF,
        });
      }
    }

    // Check if BOV asset exists
    for await (const [index, asset] of aBov.entries()) {
      const qAsset = await this.pool.query(
        `SELECT asset FROM "b3-assets-expiry" WHERE asset=$1 AND type=$2 LIMIT 1`,
        [asset, 'SPOT'],
      );

      if (qAsset.rowCount === 0) {
        this.logger.warn(`[ServiceTryd] BOV asset not recognized: ${asset}`);
        aBov.splice(index, 1);
      } else {
        assets.push({
          code: asset,
          exchange: TExchange.BOV,
        });
      }
    }

    return assets;
  }

  private async getFuturesContract(
    assetCode: string,
  ): Promise<
    { current: IFutureContract; next: IFutureContract | undefined } | undefined
  > {
    const qAssets = await this.pool.query(
      'SELECT asset, contract, "date-expiry" expiry FROM "b3-assets-expiry" WHERE asset ~ $1 AND type=$2 and "date-expiry">=NOW() ORDER BY "date-expiry" ASC LIMIT 2',
      [`^${assetCode}(F|G|H|J|K|M|N|Q|U|V|X|Z)\\d\\d$`, 'FUTURES'],
    );

    if (qAssets.rowCount === 0) return undefined;

    const next =
      qAssets.rowCount === 2
        ? {
            code: `${qAssets.rows[1].contract}`,
            expiry: dayjs(qAssets.rows[1].expiry),
          }
        : undefined;

    return {
      current: {
        code: `${qAssets.rows[0].contract}`,
        expiry: dayjs(qAssets.rows[0].expiry),
      },
      next,
    };
  }

  private async getTrydBrokers(): Promise<IBroker[]> {
    let fileBrokers = fs.readFileSync(`C:\\Tryd6\\CorBov.txt`, 'utf-8');
    const brokersBov: { id: number; name: string }[] = fileBrokers
      .split(/\r?\n/)
      .map(line => {
        const broker = line.split(';');
        return {
          id: Number(broker[0]),
          name: broker[1].split('-')[1].trim(),
        };
      });

    fileBrokers = fs.readFileSync(`C:\\Tryd6\\CorBmf.txt`, 'utf-8');
    const brokersBmf: { id: number; name: string }[] = fileBrokers
      .split(/\r?\n/)
      .map(line => {
        const broker = line.split(';');
        return {
          id: Number(broker[0]),
          name: broker[1].split('-')[1].trim(),
        };
      });

    const brokers: IBroker[] = [];
    brokersBov.forEach(bBov => {
      if (brokersBmf.find(bBmf => bBmf.id === bBov.id))
        brokers.push({
          id: bBov.id,
          name: bBov.name,
          exchange_bov: true,
          exchange_bmf: true,
        });
      else
        brokers.push({
          id: bBov.id,
          name: bBov.name,
          exchange_bov: true,
          exchange_bmf: false,
        });
    });

    brokersBmf.forEach(bBmf => {
      if (!brokers.find(b => b.id === bBmf.id))
        brokers.push({
          id: bBmf.id,
          name: bBmf.name,
          exchange_bov: false,
          exchange_bmf: true,
        });
    });

    const qBrokers = await this.pool.query(
      'SELECT id, name, "exchange-bov" bov, "exchange-bmf" bmf FROM "b3-brokers" ORDER BY id ASC',
    );

    const newBrokers: IBroker[] = [];
    const updatedBrokersBmf: IBroker[] = [];
    const updatedBrokersBov: IBroker[] = [];
    for await (const broker of brokers) {
      const bDB = qBrokers.rows.find(b => b.id === broker.id);
      if (!bDB) {
        await this.pool.query(
          'INSERT INTO "b3-brokers" (id, name, "exchange-bov", "exchange-bmf") VALUES ($1, $2, $3, $4)',
          [broker.id, broker.name, broker.exchange_bov, broker.exchange_bmf],
        );
        newBrokers.push(broker);
      } else if (
        broker.name.toUpperCase() !== String(bDB.name).toUpperCase() ||
        broker.exchange_bov !== bDB.bov ||
        broker.exchange_bmf !== bDB.bmf
      ) {
        if (broker.name.toUpperCase() === String(bDB.name).toUpperCase()) {
          await this.pool.query(
            'UPDATE "b3-brokers" SET "exchange-bov"=$2, "exchange-bmf"=$3 WHERE id=$1',
            [broker.id, broker.exchange_bov, broker.exchange_bmf],
          );
          if (
            broker.exchange_bov !== bDB.bov &&
            broker.exchange_bmf !== bDB.bmf
          )
            newBrokers.push(broker);
          else if (
            broker.exchange_bov !== bDB.bov &&
            broker.exchange_bmf === bDB.bmf
          )
            updatedBrokersBov.push(broker);
          else updatedBrokersBmf.push(broker);
        } else {
          // conflict warning broker name change
          this.logger.warn(
            `[ServiceTryd] LoadBrokers() - WARNING: Broker's name change conflict NOT UPDATED: ${JSON.stringify(
              broker,
              null,
              4,
            )} `,
          );
        }
      }
    }

    if (newBrokers.length > 0)
      this.logger.warn(
        `[TrydLoader] LoadBrokers() - WARNING: New brokers included: ${JSON.stringify(
          newBrokers,
          null,
          4,
        )} `,
      );

    if (updatedBrokersBov.length > 0)
      this.logger.warn(
        `[TrydLoader] LoadBrokers() - WARNING: BOV brokers updated: ${JSON.stringify(
          updatedBrokersBov,
          null,
          4,
        )} `,
      );

    if (updatedBrokersBmf.length > 0)
      this.logger.warn(
        `[TrydLoader] LoadBrokers() - WARNING: BMF brokers updated: ${JSON.stringify(
          updatedBrokersBmf,
          null,
          4,
        )} `,
      );

    return brokers; // KEEP removed brokers in DB for backtesting
  }
}

export { sleep };
