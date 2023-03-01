/* eslint-disable no-continue */
import { Pool } from 'pg';
import format from 'pg-format';
import { Logger } from 'tslog';
import DataRTDLoader, { IAsset } from './dataRTDLoader';

const _NAME = 'AssetsBrokersRTDLoader';

interface IBroker {
  id: number;
  active: boolean;
  volume: number;
  vwap: number;
}

interface IAssetsBrokersBalance {
  asset: IAsset;
  datetime: Date;
  brokersBalance: IBroker[];
}

export default class assetsBrokersRTDLoader extends DataRTDLoader {
  private assetsBrokersBalance: IAssetsBrokersBalance[];

  constructor(
    pool: Pool,
    logger: Logger,
    host: string,
    port: number,
    assetsBrokersBalance: IAssetsBrokersBalance[],
    dateRef?: Date,
  ) {
    super(_NAME, pool, logger, host, port, dateRef);

    if (assetsBrokersBalance.length === 0)
      throw new Error(`[${this.name}] Empty assets list is not allowed`);

    this.assetsBrokersBalance = assetsBrokersBalance;
  }

  public async startListening(): Promise<void> {
    const itens: string[] = [];
    this.assetsBrokersBalance.forEach(a => {
      const asset = a.asset.codeReplay ? a.asset.codeReplay : a.asset.code;
      a.brokersBalance.forEach(b => {
        itens.push(`RNK$S|${asset}|${b.id}|7|Qtd`);
        itens.push(`RNK$S|${asset}|${b.id}|7|Prc`);
      });
    });

    if (itens.length === 0)
      throw new Error(`[${this.name}] Empty brokers list is not allowed`);

    await this.connect(`${itens.join('#')}#`);
  }

  public loadData(chunk: Buffer): void {
    if (chunk.length <= 0) return;

    let data: string | null = chunk.toString('utf-8');

    data = (this._bufferData || '').concat(data);
    this._bufferData = null;

    if (data.substr(data.length - 1, 1) !== '#') {
      const posLastLine = data.lastIndexOf('|');
      if (posLastLine < 0) return;

      this._bufferData = (this._bufferData || '').concat(
        data.substring(posLastLine + 1),
      );
      data = data.substring(0, posLastLine);

      if (data.substr(0, 4) === 'RNK!') data = data.substr('RNK!'.length); // Removes 'COT!' at begining
    } else {
      data =
        data.substr(0, 4) === 'RNK!'
          ? data.substr('RNK!'.length, data.length - ('RNK!'.length + 1))
          : data.substr(0, data.length - 1); // Removes 'RNK!' at begining and '#' at end

      this._bufferData = null;
    }

    const now = new Date();
    data
      .replace(/(#RNK!)/g, '|')
      .split('|')
      .every(line => {
        const columns = line.split(';');
        if (
          columns.length !== 5 ||
          Number.isNaN(columns[1]) ||
          (columns[3] !== 'Qtd' && columns[3] !== 'Prc')
        ) {
          if (this.listenerCount('error') > 0)
            this.emit(
              'error',
              new Error(
                `[${this.name}] loadData() - Unknown data line format: ${line}`,
              ),
            );
          return false;
        }

        const posAssetBrokers = this.assetsBrokersBalance
          .map(a => (a.asset.codeReplay ? a.asset.codeReplay : a.asset.code))
          .indexOf(columns[0].toUpperCase());

        if (posAssetBrokers < 0) {
          if (this.listenerCount('error') > 0)
            this.emit(
              'error',
              new Error(`[${this.name}] loadData() - Unknown asset: ${line}`),
            );
          return false;
        }

        const posBroker = this.assetsBrokersBalance[
          posAssetBrokers
        ].brokersBalance
          .map(b => b.id)
          .indexOf(Number(columns[1]));

        if (posBroker < 0) {
          if (this.listenerCount('error') > 0)
            this.emit(
              'error',
              new Error(`[${this.name}] loadData() - Unknown broker: ${line}`),
            );
          return false;
        }

        if (columns[3] === 'Qtd')
          this.assetsBrokersBalance[posAssetBrokers].brokersBalance[
            posBroker
          ].volume = Number(columns[4]) || 0;
        else if (columns[3] === 'Prc')
          this.assetsBrokersBalance[posAssetBrokers].brokersBalance[
            posBroker
          ].vwap = this.trydFieldToDecimal(columns[4]);

        this.assetsBrokersBalance[posAssetBrokers].datetime =
          this.getAdjustedDatetime(now); // diffTime is updated in ServiceTryd

        if (
          this.assetsBrokersBalance[posAssetBrokers].brokersBalance[posBroker]
            .vwap > 0 ||
          this.assetsBrokersBalance[posAssetBrokers].brokersBalance[posBroker]
            .volume > 0
        )
          this.assetsBrokersBalance[posAssetBrokers].brokersBalance[
            posBroker
          ].active = true;

        return true;
      });

    data = null;
  }

  public async writeData(): Promise<void> {
    const insertParams: any[] = [];

    const now = this.getAdjustedDatetime(new Date());
    // eslint-disable-next-line no-restricted-syntax
    for await (const a of this.assetsBrokersBalance) {
      try {
        const qLast = await this.pool.query({
          text: `SELECT distinct on ("broker-id") "broker-id" brokerid, datetime, volume, vwap FROM "b3-assetsbrokers" WHERE asset=$1 AND datetime::DATE=$2::DATE ORDER BY "broker-id" ASC, datetime DESC`,
          values: [a.asset.code, now],
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
              insertParams.push([
                a.datetime,
                a.asset.code,
                b.id,
                b.volume,
                b.vwap,
                !this.diffTime,
              ]);
          }
        });
      } catch (err) {
        if (this.listenerCount('error') > 0)
          this.emit(
            'error',
            new Error(
              `[${
                this.name
              }] writeData() - Exception thrown when trying to select data from database for Asset: ${
                a.asset
              } - Error: ${JSON.stringify(err)}`,
            ),
          );
        return;
      }
    }
    if (insertParams.length === 0) return;

    try {
      await this.pool.query(
        format(
          'INSERT INTO "b3-assetsbrokers" (datetime, asset, "broker-id", volume, vwap, auction) VALUES  %L',
          insertParams,
        ),
        [],
      );
    } catch (err) {
      if (this.listenerCount('error') > 0)
        this.emit(
          'error',
          new Error(
            `[${
              this.name
            }] writeData() - Exception thrown when trying to insert data into database - Error: ${JSON.stringify(
              err,
            )}\n\nINSERT-PARAMS=${JSON.stringify(insertParams)}`,
          ),
        );
    }
  }

  public async updateDatetimeDiff(diffTime: number): Promise<number> {
    if (!diffTime || diffTime === 0) return 0;
    this.diffTime = diffTime;

    const qUpdate = await this.pool.query(
      `UPDATE "b3-assetsbrokers" SET 
      datetime=TO_TIMESTAMP((EXTRACT(EPOCH FROM datetime::TIMESTAMPTZ)*1000 - $1)/1000),
      auction=FALSE
      WHERE auction=TRUE`,
      [this.diffTime],
    );

    return qUpdate.rowCount;
  }

  public async cleanAuctionData(): Promise<number> {
    const qDel = await this.pool.query(
      `DELETE FROM "b3-assetsbrokers" WHERE auction=TRUE`,
      [],
    );

    return qDel.rowCount;
  }
}

export { IBroker, IAssetsBrokersBalance };
