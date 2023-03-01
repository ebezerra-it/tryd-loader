/* eslint-disable no-continue */
/* eslint-disable camelcase */
/* eslint-disable no-restricted-syntax */
import fs from 'fs';
import { Pool } from 'pg';
import { Logger } from 'tslog';
import dayjs, { Dayjs } from 'dayjs';
import { EventEmitter } from 'events';
import TrydHandler, { sleep } from './trydHandler';
import { IAsset } from './dataRTDLoader';
import AssetsQuotesRTDLoader from './assetsQuotesRTDLoader';
import AssetsBooksRTDLoader from './assetsBooksRTDLoader';
import AssetsBrokersRTDLoader, {
  IAssetsBrokersBalance,
} from './assetsBrokersRTDLoader';

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

interface IAssetExchange {
  asset: IAsset;
  exchange: TExchange;
}

interface IFutureContract {
  code: string;
  expiry: Dayjs;
}

const ASSETS_FUTURES_NOCONTRACT = 'FRP0, FRP1';

export default class ServiceTryd extends EventEmitter {
  private dateRef: Date;

  private logger: Logger;

  private tryd: TrydHandler;

  private assetsBrokersRTDLoader: AssetsBrokersRTDLoader | undefined;

  private assetsBooksRTDLoader: AssetsBooksRTDLoader | undefined;

  private assetsQuotesRTDLoader: AssetsQuotesRTDLoader | undefined;

  private pool: Pool;

  constructor(pool: Pool, logger: Logger, dateRef?: Date) {
    super({ captureRejections: true });
    this.tryd = new TrydHandler();
    this.logger = logger;
    this.pool = pool;
    this.dateRef = dateRef || new Date();
  }

  public async start(): Promise<void> {
    const assets = await this.getAssets();

    if (assets.length === 0) {
      this.emit(
        'error',
        new Error(
          `[ServiceTryd] Unable to start service with empty asset list`,
        ),
      );
      return;
    }

    this.logger.info(
      `[ServiceTryd] BMF assets: ${assets
        .filter(a => a.exchange === TExchange.BMF)
        .map(a => (a.asset.codeReplay ? a.asset.codeReplay : a.asset.code))
        .join(', ')}`,
    );
    this.logger.info(
      `[ServiceTryd] BOV assets: ${assets
        .filter(a => a.exchange === TExchange.BOV)
        .map(a => (a.asset.codeReplay ? a.asset.codeReplay : a.asset.code))
        .join(', ')}`,
    );

    const brokers = await this.getTrydBrokers();
    if (brokers.length === 0) {
      this.emit(
        'error',
        new Error(`[ServiceTryd] AssetsBrokers - Empty brokers is not allowed`),
      );
      return;
    }

    const assetsBrokers: IAssetsBrokersBalance[] = assets.map(a => {
      const brokersExchange = brokers.filter(
        b =>
          b.exchange_bmf === (a.exchange === TExchange.BMF) ||
          b.exchange_bov === (a.exchange === TExchange.BOV),
      );
      if (!brokersExchange) {
        this.emit(
          'error',
          new Error(
            `[ServiceTryd] AssetsBrokers - Could not select any broker for asset exchange: ${JSON.stringify(
              a,
            )}`,
          ),
        );
      }
      return {
        asset: { code: a.asset.code, codeReplay: a.asset.codeReplay },
        datetime: this.dateRef,
        brokersBalance: brokersExchange.map(b => {
          return {
            id: b.id,
            active: false,
            volume: 0,
            vwap: 0,
          };
        }),
      };
    });
    this.assetsBrokersRTDLoader = new AssetsBrokersRTDLoader(
      this.pool,
      this.logger,
      process.env.TRYDLOADER_RTD_SERVER_HOST || '127.0.0.1',
      Number(process.env.TRYDLOADER_RTD_SERVER_PORT || '12002'),
      assetsBrokers,
      this.dateRef,
    );
    this.assetsBrokersRTDLoader.once('error', error => {
      if (this.listenerCount('error') > 0) this.emit('error', error);
    });

    this.assetsBooksRTDLoader = new AssetsBooksRTDLoader(
      this.pool,
      this.logger,
      process.env.TRYDLOADER_RTD_SERVER_HOST || '127.0.0.1',
      Number(process.env.TRYDLOADER_RTD_SERVER_PORT || '12002'),
      assetsBrokers.map(a => {
        return {
          code: a.asset.code,
          codeReplay: a.asset.codeReplay,
        };
      }),
      this.dateRef,
    );
    this.assetsBooksRTDLoader.once('error', error => {
      if (this.listenerCount('error') > 0) this.emit('error', error);
    });

    this.assetsQuotesRTDLoader = new AssetsQuotesRTDLoader(
      this.pool,
      this.logger,
      process.env.TRYDLOADER_RTD_SERVER_HOST || '127.0.0.1',
      Number(process.env.TRYDLOADER_RTD_SERVER_PORT || '12002'),
      assetsBrokers.map(a => {
        return {
          code: a.asset.code,
          codeReplay: a.asset.codeReplay,
        };
      }),
      this.dateRef,
    );
    this.assetsQuotesRTDLoader.once('error', error => {
      if (this.listenerCount('error') > 0) this.emit('error', error);
    });
    this.assetsQuotesRTDLoader.once(
      'quotedifftime',
      async (difftime: number) => {
        this.logger.info(
          `[ServiceTryd] AssetsQuotes - Auction records updated: ${await this.assetsQuotesRTDLoader!.updateDatetimeDiff(
            difftime,
          )}`,
        );
        this.logger.info(
          `[ServiceTryd] AssetsBrokers - Auction records updated: ${await this.assetsBrokersRTDLoader!.updateDatetimeDiff(
            difftime,
          )}`,
        );
        this.logger.info(
          `[ServiceTryd] AssetsBooks - Auction records updated: ${await this.assetsBooksRTDLoader!.updateDatetimeDiff(
            difftime,
          )}`,
        );
      },
    );
    this.assetsQuotesRTDLoader.once('shutdowntime', (datetime: Date) => {
      process.env.TRYDLOADER_RUN_SERVICE = 'FALSE';
      this.logger.warn(
        `[ServiceTryd] Service programmed stop time: ${
          process.env.TRYDLOADER_SHUTDOWN_TIME
        } reached: ${datetime.toLocaleDateString(
          'pt-br',
        )} ${datetime.toLocaleTimeString('pt-br')}`,
      );
    });

    this.tryd.on('ConnectionDown', () => {
      this.logger.warn(
        `[ServiceTryd] ALERT: Tryd connection is down! Waiting for online connection...`,
      );
    });
    this.tryd.on('ConnectionUp', () => {
      this.logger.warn(`[ServiceTryd] ALERT: Tryd connection is up again!`);
    });

    await sleep(Number(process.env.TRYDLOADER_SERVICE_START_DELAY || '30')); // wait for OS ready

    await this.tryd.open();
    await this.tryd.startDataListening();

    try {
      await this.cleanAuctionData();
      this.startAssetsDataListening();
      this.logger.info(
        `[ServiceTryd] Service started for environment: ${
          process.env.NODE_ENV
        } - DateRef: ${this.dateRef.toLocaleDateString()}`,
      );
    } catch (err) {
      this.emit(
        'error',
        new Error(
          `[ServiceTryd] Service failed to start: ${JSON.stringify(err)}`,
        ),
      );
    }
  }

  private async startAssetsDataListening(): Promise<void> {
    if (this.assetsQuotesRTDLoader) this.assetsQuotesRTDLoader.startListening();
    if (this.assetsBooksRTDLoader) this.assetsBooksRTDLoader.startListening();
    if (this.assetsBrokersRTDLoader)
      this.assetsBrokersRTDLoader.startListening();
  }

  public async stop(): Promise<void> {
    if (this.assetsQuotesRTDLoader) this.assetsQuotesRTDLoader.stopListening();
    if (this.assetsBooksRTDLoader) this.assetsBooksRTDLoader.stopListening();
    if (this.assetsBrokersRTDLoader)
      this.assetsBrokersRTDLoader.stopListening();

    await this.cleanAuctionData();

    this.removeAllListeners();
    this.tryd.removeAllListeners();

    await this.tryd.close();

    this.logger.info(`[ServiceTryd] Service stopped`);
  }

  public async cleanAuctionData(): Promise<void> {
    let delAuctionData = 0;
    if (this.assetsQuotesRTDLoader) {
      delAuctionData = await this.assetsQuotesRTDLoader.cleanAuctionData();
      if (delAuctionData > 0)
        this.logger.info(
          `[ServiceTryd] AssetsQuotes - Auction records deleted: ${delAuctionData}`,
        );
    }

    if (this.assetsBooksRTDLoader) {
      delAuctionData = await this.assetsBooksRTDLoader.cleanAuctionData();
      if (delAuctionData > 0)
        this.logger.info(
          `[ServiceTryd] AssetsQuotes - Auction records deleted: ${delAuctionData}`,
        );
    }

    if (this.assetsBrokersRTDLoader) {
      delAuctionData = await this.assetsBrokersRTDLoader.cleanAuctionData();
      if (delAuctionData > 0)
        this.logger.info(
          `[ServiceTryd] AssetsQuotes - Auction records deleted: ${delAuctionData}`,
        );
    }
  }

  private async getAssets(): Promise<IAssetExchange[]> {
    const assets: IAssetExchange[] = [];

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
      if (
        ASSETS_FUTURES_NOCONTRACT.split(',').find(
          a => a.trim().toUpperCase() === asset,
        )
      )
        assets.push({
          asset: { code: asset },
          exchange: TExchange.BMF,
        });
      else {
        let assetCode = asset.replace(/\$(1|2|3|A[1-3])/g, '');

        if (
          asset.indexOf('$1') >= 0 &&
          (asset.indexOf('$2') >= 0 || asset.indexOf('$3') >= 0)
        ) {
          const qRoll = await this.pool.query({
            text: `SELECT asset, "underlying-asset" underasset FROM "b3-assets-expiry" WHERE asset ~ $1 AND type=$2 and "product-group"=$3 and "date-expiry"::DATE>$4::DATE ORDER BY "date-expiry" ASC, asset ASC LIMIT 2`,
            values: [
              `^${assetCode}(F|G|H|J|K|M|N|Q|U|V|X|Z)\\d\\d(F|G|H|J|K|M|N|Q|U|V|X|Z)\\d\\d$`,
              'FUTURES',
              'ROLLOVER',
              this.dateRef,
            ],
          });
          if (qRoll.rowCount === 0) {
            this.logger.warn(
              `[ServiceTryd] BMF asset not recognized: ${asset}`,
            );
            aBmf.splice(index, 1);
            continue;
          }
          assetCode = String(qRoll.rows[0].underasset).trim().toUpperCase();
        }

        const contracts = await this.getFuturesContract(assetCode);

        if (
          !contracts ||
          (asset.indexOf('$2') >= 0 && !contracts.next1) ||
          (asset.indexOf('$3') >= 0 && !contracts.next2)
        ) {
          this.logger.warn(
            `[ServiceTryd] BMF asset not recognized: ${asset} - Contracts: ${JSON.stringify(
              contracts,
            )}`,
          );
          aBmf.splice(index, 1);
          continue;
        } else {
          const codeReplay =
            contracts.today &&
            contracts.today.code !== contracts.current.code &&
            asset.indexOf('$2') < 0 &&
            asset.indexOf('$3') < 0 &&
            asset.indexOf('$A1') < 0 &&
            asset.indexOf('$A2') < 0 &&
            asset.indexOf('$A3') < 0
              ? contracts.today.code
              : undefined;

          if (
            asset.indexOf('$2') >= 0 &&
            codeReplay &&
            asset.replace('$2', contracts.next1 ? contracts.next1.code : '') ===
              asset.replace('$2', codeReplay)
          ) {
            this.logger.warn(
              `[ServiceTryd] BMF asset ignored due to loading replay: ${asset} => ${asset.replace(
                '$2',
                contracts.next1 ? contracts.next1.code : '',
              )}`,
            );
            continue;
          }

          if (
            asset.indexOf('$3') >= 0 &&
            codeReplay &&
            asset.replace('$3', contracts.next2 ? contracts.next2.code : '') ===
              asset.replace('$3', codeReplay)
          ) {
            this.logger.warn(
              `[ServiceTryd] BMF asset ignored due to loading replay: ${asset} => ${asset.replace(
                '$2',
                contracts.next2 ? contracts.next2.code : '',
              )}`,
            );
            continue;
          }

          assets.push({
            asset: {
              code: asset
                .replace('$1', contracts.current.code)
                .replace('$2', contracts.next1 ? contracts.next1.code : '')
                .replace('$3', contracts.next2 ? contracts.next2.code : '')
                .replace('$A1', contracts.a1 ? contracts.a1.code : '')
                .replace('$A2', contracts.a2 ? contracts.a2.code : '')
                .replace('$A3', contracts.a3 ? contracts.a3.code : ''),
              codeReplay: codeReplay
                ? asset.replace('$1', codeReplay)
                : undefined,
            },
            exchange: TExchange.BMF,
          });
        }
      }
    }

    // Check if BOV asset exists
    for await (const [index, asset] of aBov.entries()) {
      const qAsset = await this.pool.query({
        text: `SELECT asset FROM "b3-assets-expiry" WHERE asset=$1 AND type=$2 LIMIT 1`,
        values: [asset, 'SPOT'],
      });

      if (qAsset.rowCount === 0) {
        this.logger.warn(`[ServiceTryd] BOV asset not recognized: ${asset}`);
        aBov.splice(index, 1);
      } else {
        assets.push({
          asset: { code: asset },
          exchange: TExchange.BOV,
        });
      }
    }

    const brokerRankingMaxSecurities = Number(
      process.env.TRYDLOADER_BROKER_RANKING_MAX_SECURITIES || '20',
    );

    if (brokerRankingMaxSecurities <= 0) {
      this.emit(
        'error',
        new Error(
          `[ServiceTryd] Wrong BROKER_RANKING_MAX_SECURITIES parameter: ${brokerRankingMaxSecurities}`,
        ),
      );
      return assets;
    }

    if (assets.length > brokerRankingMaxSecurities) {
      assets.splice(brokerRankingMaxSecurities);
      this.logger.warn(
        `[ServiceTryd] Assets limited to parameter BROKER_RANKING_MAX_SECURITIES: ${brokerRankingMaxSecurities} - Accepted assets: ${assets
          .map(a => (a.asset.codeReplay ? a.asset.codeReplay : a.asset.code))
          .join(', ')}`,
      );
    }

    return assets;
  }

  private async getFuturesContract(assetCode: string): Promise<
    | {
        today: IFutureContract;
        current: IFutureContract;
        next1: IFutureContract | undefined;
        next2: IFutureContract | undefined;
        a1: IFutureContract | undefined;
        a2: IFutureContract | undefined;
        a3: IFutureContract | undefined;
      }
    | undefined
  > {
    const qToday = await this.pool.query({
      text: `SELECT asset, contract, "date-expiry" expiry FROM "b3-assets-expiry" WHERE asset ~ $1 AND type=$2 and "date-expiry"::DATE>NOW()::DATE ORDER BY "date-expiry" ASC LIMIT 1`,
      values: [`^${assetCode}(F|G|H|J|K|M|N|Q|U|V|X|Z)\\d\\d$`, 'FUTURES'],
    });

    if (qToday.rowCount === 0) return undefined;

    const qContracts = await this.pool.query({
      text: `SELECT asset, contract, "date-expiry" expiry FROM "b3-assets-expiry" WHERE asset ~ $1 AND type=$2 and "date-expiry"::DATE>$3::DATE ORDER BY "date-expiry" ASC LIMIT 3`,
      values: [
        `^${assetCode}(F|G|H|J|K|M|N|Q|U|V|X|Z)\\d\\d$`,
        'FUTURES',
        this.dateRef,
      ],
    });

    if (qContracts.rowCount === 0) return undefined;

    const next1 =
      qContracts.rowCount > 1
        ? {
            code: `${qContracts.rows[1].contract}`,
            expiry: dayjs(qContracts.rows[1].expiry),
          }
        : undefined;

    const next2 =
      qContracts.rowCount > 2
        ? {
            code: `${qContracts.rows[2].contract}`,
            expiry: dayjs(qContracts.rows[2].expiry),
          }
        : undefined;

    const qAn = await this.pool.query({
      text: `SELECT asset, contract, "date-expiry" expiry FROM "b3-assets-expiry" WHERE asset ~ $1 AND type=$2 and "date-expiry"::DATE>NOW()::DATE ORDER BY "date-expiry" ASC LIMIT 3`,
      values: [`^${assetCode}F\\d\\d$`, 'FUTURES'],
    });

    return {
      today: {
        code: `${qToday.rows[0].contract}`,
        expiry: dayjs(qToday.rows[0].expiry),
      },
      current: {
        code: `${qContracts.rows[0].contract}`,
        expiry: dayjs(qContracts.rows[0].expiry),
      },
      next1,
      next2,
      a1:
        qAn.rowCount > 0
          ? {
              code: `${qAn.rows[0].contract}`,
              expiry: dayjs(qAn.rows[0].expiry),
            }
          : undefined,
      a2:
        qAn.rowCount > 1
          ? {
              code: `${qAn.rows[1].contract}`,
              expiry: dayjs(qAn.rows[1].expiry),
            }
          : undefined,
      a3:
        qAn.rowCount > 2
          ? {
              code: `${qAn.rows[2].contract}`,
              expiry: dayjs(qAn.rows[2].expiry),
            }
          : undefined,
    };
  }

  private async getTrydBrokers(): Promise<IBroker[]> {
    let fileBrokers = '';

    try {
      fileBrokers = fs.readFileSync(`C:\\Tryd6\\CorBov.txt`, 'utf-8');
    } catch (err) {
      this.logger.warn(
        `[ServiceTryd] Could not read BOV brokers from Tryd file. Using database data instead - Error: ${JSON.stringify(
          err,
        )}`,
      );
    }
    let brokersBov: { id: number; name: string }[];
    brokersBov = fileBrokers.split(/\r?\n/).map(line => {
      const broker = line.split(';');
      return {
        id: Number(broker[0]),
        name: broker[1].split('-')[1].trim(),
      };
    });

    fileBrokers = '';
    try {
      fileBrokers = fs.readFileSync(`C:\\Tryd6\\CorBmf.txt`, 'utf-8');
    } catch (err) {
      this.logger.warn(
        `[ServiceTryd] Could not read BMF brokers from Tryd file. Using database data instead - Error: ${JSON.stringify(
          err,
        )}`,
      );
    }
    let brokersBmf: { id: number; name: string }[];
    brokersBmf = fileBrokers.split(/\r?\n/).map(line => {
      const broker = line.split(';');
      return {
        id: Number(broker[0]),
        name: broker[1].split('-')[1].trim(),
      };
    });

    const brokers: IBroker[] = [];
    const qBrokers = await this.pool.query({
      text: 'SELECT id, name, "exchange-bov" bov, "exchange-bmf" bmf FROM "b3-brokers" ORDER BY id ASC',
    });
    if (!brokersBov || brokersBov.length === 0) {
      brokersBov = qBrokers.rows
        .filter(b => b.bov)
        .map(b => {
          return {
            id: Number(b.id),
            name: b.name,
          };
        });
    }
    if (!brokersBmf || brokersBmf.length === 0) {
      brokersBmf = qBrokers.rows
        .filter(b => b.bov)
        .map(b => {
          return {
            id: Number(b.id),
            name: b.name,
          };
        });
    }

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

    const newBrokers: IBroker[] = [];
    const updatedBrokersBmf: IBroker[] = [];
    const updatedBrokersBov: IBroker[] = [];
    for await (const broker of brokers) {
      const bDB = qBrokers.rows.find((b: any) => b.id === broker.id);
      if (!bDB) {
        await this.pool.query({
          text: 'INSERT INTO "b3-brokers" (id, name, "exchange-bov", "exchange-bmf") VALUES ($1, $2, $3, $4)',
          values: [
            broker.id,
            broker.name,
            broker.exchange_bov,
            broker.exchange_bmf,
          ],
        });
        newBrokers.push(broker);
      } else if (
        broker.name.toUpperCase() !== String(bDB.name).toUpperCase() ||
        broker.exchange_bov !== bDB.bov ||
        broker.exchange_bmf !== bDB.bmf
      ) {
        if (broker.name.toUpperCase() === String(bDB.name).toUpperCase()) {
          await this.pool.query({
            text: 'UPDATE "b3-brokers" SET "exchange-bov"=$2, "exchange-bmf"=$3 WHERE id=$1',
            values: [broker.id, broker.exchange_bov, broker.exchange_bmf],
          });
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
