/* eslint-disable no-continue */
/* eslint-disable no-restricted-syntax */
import { createClients, Clients } from 'node-dde-with-edge-js';
import dayjs, { Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { Logger } from 'tslog';
import QueryFactory from './queryFactory';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault(process.env.TZ || 'America/Sao_Paulo');
dayjs.extend(customParseFormat);

interface IBroker {
  asset: string;
  id: number;
  name: string;
  active: boolean;
  volume: number;
  vwap: number;
}

enum TDDEReturnType {
  STRING,
  INTEGER,
  DECIMAL,
  DATE,
  DAYJS,
  BOOLEAN,
}

const WRITE_INTERVAL = 5;

export default class BrokersDDELoader {
  public asset: string;

  private logger: Logger;

  private queryFactory: QueryFactory;

  private dde: Clients;

  private assetBrokersBalance: IBroker[];

  private _writeTimer: NodeJS.Timer | undefined;

  private _ddeEventCheckLastTrade: (
    service: string,
    topic: string,
    item: string,
    text: string,
  ) => void;

  private _ddeEventLoadData: (
    service: string,
    topic: string,
    item: string,
    text: string,
  ) => void;

  constructor(
    asset: string,
    logger: Logger,
    queryFactory: QueryFactory,
    brokersList: { id: number; name: string }[],
  ) {
    if (brokersList.length === 0) throw new Error(`Empty brokersList`);

    this.assetBrokersBalance = brokersList.map(p => {
      return {
        asset,
        id: p.id,
        name: p.name,
        active: false,
        volume: 0,
        vwap: 0,
      };
    });

    this.asset = asset;

    this.queryFactory = queryFactory;

    this.logger = logger;

    this.dde = createClients({
      Stech: {
        NEG: `${asset}.Hora`,
      },
    });

    this._ddeEventCheckLastTrade = (
      service: string,
      topic: string,
      item: string,
      text: string,
    ) => {
      const time = text.match(/(\d\d):(\d\d):(\d\d)/);
      if (!time) return;

      time.splice(0, 1);

      const lastTrade = dayjs()
        .set('hour', Number(time[0]))
        .set('minute', Number(time[1]))
        .set('second', Number(time[2]));

      // check if last trade was today
      if (dayjs().diff(lastTrade, 'minute', true) > 1) return;

      this.dde.removeListener('advise', this._ddeEventCheckLastTrade);
      this.dde.stopAdvise();

      this.startLoadingData();
      logger.info(`[BrokersDDELoader] Asset: ${asset} started loading data.`);
    };

    this._ddeEventLoadData = (
      service: string,
      topic: string,
      item: string,
      text: string,
    ) => {
      const match = item.toUpperCase().split('.');
      const idBroker = Number(match[1]);
      if (Number.isNaN(idBroker))
        throw new Error(
          `[BrokersDDELoader] Unknown DDE returned broker-id: ${service}-${topic}-${item}: ${text}`,
        );

      const brokerBal = this.assetBrokersBalance.find(p => p.id === idBroker);
      if (!brokerBal) return;

      // eslint-disable-next-line prefer-destructuring
      brokerBal.asset = match[0];
      if (match[3] === 'PRC')
        brokerBal.vwap =
          <number>this.castDDEReturnToType(text, TDDEReturnType.DECIMAL) || 0;
      else if (match[3] === 'QTD')
        brokerBal.volume =
          <number>this.castDDEReturnToType(text, TDDEReturnType.DECIMAL) || 0;
    };
  }

  private waitForDataOfDay() {
    this.dde = createClients({
      Stech: {
        NEG: [`${this.asset}.Hora`],
      },
    });

    this.dde.on('advise', this._ddeEventCheckLastTrade);

    try {
      this.dde.connect();
    } catch (err) {
      throw new Error(
        `[BrokersDDELoader] Unable to connect to DDE source - Asset: ${this.asset}`,
      );
    }
    this.dde.startAdvise();
  }

  public startListening(): void {
    this.waitForDataOfDay();
  }

  public startLoadingData(): void {
    const ddeItens: string[] = [];
    this.assetBrokersBalance.forEach(b => {
      ddeItens.push(`${b.asset}.${b.id}.7.Qtd`);
      ddeItens.push(`${b.asset}.${b.id}.7.Prc`);
    });

    this.dde = createClients({
      Stech: {
        RNK: ddeItens,
      },
    });
    this.dde.on('advise', this._ddeEventLoadData);

    try {
      this.dde.connect();
    } catch (err) {
      throw new Error(
        `[BrokersDDELoader] Unable to connect to DDE source - Asset: ${this.asset}`,
      );
    }
    this.dde.startAdvise();

    this._writeTimer = setInterval(
      async () => this.updateDataBase(),
      WRITE_INTERVAL * 1000,
    );
  }

  public async stopListening(): Promise<void> {
    if (this._writeTimer) clearInterval(this._writeTimer);

    if (this.dde.isConnected()) this.dde.stopAdvise();
    this.dde.removeAllListeners(['advise']);
  }

  private async updateDataBase(): Promise<void> {
    clearInterval(this._writeTimer);

    let query;
    const now: Dayjs = dayjs();

    for await (const broker of this.assetBrokersBalance) {
      // break update if service stops running
      if (
        String(process.env.TRYDLOADER_RUN_SERVICE || '')
          .trim()
          .toUpperCase() !== 'TRUE'
      )
        break;

      if ((broker.vwap !== 0 && broker.volume !== 0) || broker.active) {
        if (!broker.active) broker.active = true;
        query = {
          text: `SELECT datetime, volume, vwap FROM "b3-brokersbalance" WHERE asset=$1 AND "broker-id"=$2 ORDER BY datetime DESC LIMIT 1`,
          values: [broker.asset, broker.id],
        };

        const qLast = await this.queryFactory.query(query);
        if (
          qLast &&
          qLast.rowCount > 0 &&
          Number(qLast.rows[0].volume) === broker.volume &&
          Number(qLast.rows[0].vwap) === broker.vwap
        ) {
          continue;
        }

        query = {
          text: `INSERT INTO "b3-brokersbalance" (datetime, asset, "broker-id", volume, vwap) VALUES ($1, $2, $3, $4, $5)`,
          values: [
            now.toDate(),
            broker.asset,
            broker.id,
            broker.volume,
            broker.vwap,
          ],
        };
        await this.queryFactory.query(query);
      }
    }

    this._writeTimer = setInterval(
      async () => this.updateDataBase(),
      WRITE_INTERVAL * 1000,
    );
  }

  private castDDEReturnToType(
    text: string,
    type: TDDEReturnType,
    dateFormat?: string,
  ): string | number | Dayjs | undefined {
    // remove ASCII(0) from DDE return
    const value = text.replace(String.fromCharCode(0), '').trim();
    let castValue: any;
    switch (type) {
      case TDDEReturnType.INTEGER:
        castValue = Math.trunc(Number(value.replace(',', '.')));
        if (Number.isNaN(castValue))
          throw new Error(
            `[BrokersDDELoader] Unable to cast DDE return ${text} to type: ${type}`,
          );
        break;

      case TDDEReturnType.DECIMAL:
        castValue = Number(value.replace(',', '.'));
        if (Number.isNaN(castValue))
          throw new Error(
            `[BrokersDDELoader] Unable to cast DDE return ${text} to type: ${type}`,
          );
        break;

      case TDDEReturnType.DATE:
        castValue = dayjs(value, dateFormat);
        if (Number.isNaN(castValue))
          throw new Error(
            `[BrokersDDELoader] Unable to cast DDE return ${text} to type: ${type} format: ${dateFormat}`,
          );

        castValue = castValue.toDate();
        break;

      case TDDEReturnType.DAYJS:
        castValue = dayjs(value, dateFormat);
        if (Number.isNaN(castValue))
          throw new Error(
            `[BrokersDDELoader] Unable to cast DDE return ${text} to type: ${type} format: ${dateFormat}`,
          );

        break;
      case TDDEReturnType.BOOLEAN:
        castValue = value.toUpperCase() === 'TRUE';
        break;

      case TDDEReturnType.STRING:
      default:
        return value;
    }

    return castValue;
  }
}
