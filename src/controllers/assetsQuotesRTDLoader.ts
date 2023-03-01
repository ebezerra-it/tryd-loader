/* eslint-disable no-continue */
import { Pool } from 'pg';
import format from 'pg-format';
import { Logger } from 'tslog';
import DataRTDLoader, { IAsset } from './dataRTDLoader';

const _NAME = 'AssetsQuotesRTDLoader';

interface IAssetQuotes {
  asset: IAsset;
  datetime: Date | undefined;
  open: number;
  high: number;
  low: number;
  last: number;
  vwap: number;
  quantity: number;
  volume: number;
  aggressionQuantityBuy: number;
  aggressionQuantitySell: number;
  aggressionVolumeBuy: number;
  aggressionVolumeSell: number;
  theoricalLevel: number;
  theoricalVolumeBuy: number;
  theoricalVolumeSell: number;
  state: string;
  active: boolean;
}

enum TTrydQuote {
  ASSET = 0,
  LAST = 1,
  BID_VOLUME = 3,
  BID_LEVEL = 4,
  ASK_LEVEL = 5,
  ASK_VOLUME = 6,
  OPEN = 7,
  HIGH = 8,
  LOW = 9,
  CLOSE = 10,
  TIME = 12,
  TRADES_QUANTITY = 14,
  VWAP = 15,
  VOLUME = 16,
  STATE = 18,
  EXPIRY = 19,
  DAYS_TO_EXPIRY = 21,
  BUSINESS_DAYS_TO_EXPIRY = 22,
  DATE = 25,
  DATETIME = 26,
  ASSET_DESCRIPTION = 27,
  THEORICAL_LEVEL = 37,
  THEORICAL_VOLUME = 38,
  END_TIME_AUCTION = 39,
  OPEN_INTERESTS = 40,
  D1_ADJUSTED_LEVEL = 41,
  AGGRESSION_VOLUME_BUY = 46,
  AGGRESSION_VOLUME_SELL = 49,
  THEORICAL_VOLUME_DIFF = 61,
  THEORICAL_IND_NET_VOLUME = 62,
  AGGRESSION_QUANTITY_BUY = 63,
  AGGRESSION_QUANTITY_SELL = 66,
}

enum TTrydQuoteState {
  PREMARKET = 'PREMARKET', // Before leilão
  AUCTION = 'AUCTION', // Leilão
  AUCTION_EXTENTION = 'AUCTION_EXTENTION', // Prorrogação de leilão
  TRADING = 'TRADING', // Normal
  FROZEN = 'FROZEN', // Suspenso
  CLOSED = 'CLOSED',
  UNKNOWN = 'UNKNOWN',
}

enum TTheoricalIndNetVolume {
  BUY = 'B',
  SELL = 'S',
  EVEN = 'E',
}

export default class assetsQuotesRTDLoader extends DataRTDLoader {
  private assetsQuotes: IAssetQuotes[];

  constructor(
    pool: Pool,
    logger: Logger,
    host: string,
    port: number,
    assets: IAsset[],
    dateRef?: Date,
  ) {
    super(_NAME, pool, logger, host, port, dateRef);

    if (assets.length === 0)
      throw new Error(`[${this.name}] Empty assets list is not allowed`);

    this.assetsQuotes = assets.map(a => {
      return {
        asset: a,
        datetime: undefined,
        open: 0,
        high: 0,
        low: 0,
        last: 0,
        vwap: 0,
        quantity: 0,
        volume: 0,
        aggressionQuantityBuy: 0,
        aggressionQuantitySell: 0,
        aggressionVolumeBuy: 0,
        aggressionVolumeSell: 0,
        theoricalLevel: 0,
        theoricalVolumeBuy: 0,
        theoricalVolumeSell: 0,
        state: '',
        active: false,
      };
    });
  }

  public async startListening(): Promise<void> {
    const itens: string[] = [];
    this.assetsQuotes.forEach(a => {
      itens.push(
        `COT$S|${a.asset.codeReplay ? a.asset.codeReplay : a.asset.code}`,
      );
    });

    if (itens.length === 0)
      throw new Error(`[${this.name}] Empty assets list is not allowed`);

    await this.connect(`${itens.join('#')}#`);
  }

  public loadData(chunk: Buffer): void {
    if (chunk.length <= 0) return;

    let data: string | null = chunk.toString('utf-8');

    data = (this._bufferData || '').concat(data);
    this._bufferData = null;

    if (data.substr(data.length - 1, 1) !== '#') {
      const posLastLine = data.lastIndexOf('#COT!');
      if (posLastLine < 0) return;

      this._bufferData = (this._bufferData || '').concat(
        data.substring(posLastLine + 1),
      );
      data = data.substring(0, posLastLine);

      if (data.substr(0, 4) === 'COT!') data = data.substr('COT!'.length); // Removes 'COT!' at begining
    } else {
      data =
        data.substr(0, 4) === 'COT!'
          ? data.substr('COT!'.length, data.length - ('COT!'.length + 1))
          : data.substr(0, data.length - 1); // Removes 'COT!' at begining and '#' at end

      this._bufferData = null;
    }

    const now = new Date();
    let indDateTime = false;
    const quoteDateTime: { asset: string; datetime: number }[] = [];
    data
      .replace(/(#COT!)/g, '#')
      .split('#')
      .every(line => {
        const columns = line.split('|');
        if (columns.length < 90) {
          if (this.listenerCount('error') > 0)
            this.emit(
              'error',
              new Error(
                `[${this.name}] loadData() - Unknown data line format: ${line}`,
              ),
            );
          return false;
        }

        let asset = columns[TTrydQuote.ASSET].trim().toUpperCase();
        const posAssetQuotes = this.assetsQuotes
          .map(a => (a.asset.codeReplay ? a.asset.codeReplay : a.asset.code))
          .indexOf(asset);

        if (posAssetQuotes < 0) {
          if (this.listenerCount('error') > 0)
            this.emit(
              'error',
              new Error(`[${this.name}] loadData() - Unknown asset: ${line}`),
            );
          return false;
        }
        asset = this.assetsQuotes[posAssetQuotes].asset.code;

        let datetime = this.parseTrydDate(
          `${columns[TTrydQuote.DATE]} ${columns[TTrydQuote.TIME]}`,
        );
        if (datetime && this.isSameDay(datetime, this.dateRef))
          quoteDateTime.push({ asset, datetime: datetime.getTime() });

        let state;
        if (!datetime)
          state =
            columns[TTrydQuote.STATE].trim() === ''
              ? ''
              : TTrydQuoteState.PREMARKET;
        else {
          state = this.getTrydQuoteState(
            columns[TTrydQuote.STATE]
              .trim()
              .toUpperCase()
              .normalize('NFD')
              .replace(/\p{Diacritic}/gu, ''),
          );
          if (!datetime && state === TTrydQuoteState.TRADING)
            state = TTrydQuoteState.PREMARKET;
          else if (state === TTrydQuoteState.UNKNOWN) {
            if (columns[TTrydQuote.STATE] === '') state = '';
            else {
              state = columns[TTrydQuote.STATE];
              this.logger.warn(
                `[${this.name}] STATE field domain exception: "${state}" - Asset: ${asset} - Datetime: ${datetime}`,
              );
            }
          }
        }

        if (datetime && !this.diffTime) {
          if (!this.isSameDay(datetime, this.dateRef)) {
            if (this.listenerCount('error') > 0)
              this.emit(
                'error',
                new Error(
                  `[${this.name}] loadData() - Incompatible reference date - DateRef: ${this.dateRef} - Datetime: ${datetime}`,
                ),
              );
            return false;
          }
          indDateTime = true;
          /* this.diffTime = this.calculateDiffTime(now, datetime);
          if (this.listenerCount('quotedifftime') > 0 && this.diffTime)
            this.emit('quotedifftime', this.diffTime); */
        }
        datetime = this.getAdjustedDatetime(now);

        const open = this.trydFieldToDecimal(columns[TTrydQuote.OPEN]);
        const high = this.trydFieldToDecimal(columns[TTrydQuote.HIGH]);
        const low = this.trydFieldToDecimal(columns[TTrydQuote.LOW]);
        const last = this.trydFieldToDecimal(columns[TTrydQuote.LAST]);
        const vwap = this.trydFieldToDecimal(columns[TTrydQuote.VWAP]);
        const volume = Number(columns[TTrydQuote.VOLUME]) || 0;
        const quantity = Number(columns[TTrydQuote.TRADES_QUANTITY]) || 0;
        const aggressionQuantityBuy =
          Number(columns[TTrydQuote.AGGRESSION_QUANTITY_BUY]) || 0;
        const aggressionQuantitySell =
          Number(columns[TTrydQuote.AGGRESSION_QUANTITY_SELL]) || 0;
        const aggressionVolumeBuy =
          Number(columns[TTrydQuote.AGGRESSION_VOLUME_BUY]) || 0;
        const aggressionVolumeSell =
          Number(columns[TTrydQuote.AGGRESSION_VOLUME_SELL]) || 0;
        const theoricalLevel = this.trydFieldToDecimal(
          columns[TTrydQuote.THEORICAL_LEVEL],
        );
        let theoricalVolumeBuy =
          Number(columns[TTrydQuote.THEORICAL_VOLUME]) || 0;
        let theoricalVolumeSell =
          Number(columns[TTrydQuote.THEORICAL_VOLUME]) || 0;
        const theoricalVolumeDiff =
          Number(columns[TTrydQuote.THEORICAL_VOLUME_DIFF]) || 0;
        const theoricalIndNetVolume =
          theoricalLevel > 0
            ? this.getTrydTheoricalIndNetVolume(
                columns[TTrydQuote.THEORICAL_IND_NET_VOLUME]
                  .trim()
                  .toUpperCase(),
              )
            : undefined;
        if (theoricalIndNetVolume === TTheoricalIndNetVolume.SELL) {
          theoricalVolumeBuy =
            Number(columns[TTrydQuote.THEORICAL_VOLUME]) || 0;
          theoricalVolumeSell = theoricalVolumeBuy + theoricalVolumeDiff;
        } else if (theoricalIndNetVolume === TTheoricalIndNetVolume.BUY) {
          theoricalVolumeSell =
            Number(columns[TTrydQuote.THEORICAL_VOLUME]) || 0;
          theoricalVolumeBuy = theoricalVolumeSell + theoricalVolumeDiff;
        } else if (
          theoricalIndNetVolume &&
          theoricalIndNetVolume !== TTheoricalIndNetVolume.EVEN
        ) {
          // store data in case of field domain exception
          this.logger.warn(
            `[${
              this.name
            }] THEORICAL-IND-NET-VOLUME field domain exception: ${theoricalIndNetVolume} - Data: ${JSON.stringify(
              {
                asset,
                datetime,
                theoricalIndNetVolume,
                theoricalLevel: columns[TTrydQuote.THEORICAL_LEVEL],
                theoricalVolume: columns[TTrydQuote.THEORICAL_VOLUME],
                theoricalVolumeDiff: columns[TTrydQuote.THEORICAL_VOLUME_DIFF],
              },
              null,
              4,
            )}`,
          );
        }

        if (!datetime || (vwap === 0 && theoricalLevel === 0)) return true; // ignore line

        this.assetsQuotes[posAssetQuotes].datetime = datetime;
        this.assetsQuotes[posAssetQuotes].open = open;
        this.assetsQuotes[posAssetQuotes].high = high;
        this.assetsQuotes[posAssetQuotes].low = low;
        this.assetsQuotes[posAssetQuotes].last = last;
        this.assetsQuotes[posAssetQuotes].vwap = vwap;
        this.assetsQuotes[posAssetQuotes].quantity = quantity;
        this.assetsQuotes[posAssetQuotes].volume = volume;
        this.assetsQuotes[posAssetQuotes].aggressionQuantityBuy =
          aggressionQuantityBuy;
        this.assetsQuotes[posAssetQuotes].aggressionQuantitySell =
          aggressionQuantitySell;
        this.assetsQuotes[posAssetQuotes].aggressionVolumeBuy =
          aggressionVolumeBuy;
        this.assetsQuotes[posAssetQuotes].aggressionVolumeSell =
          aggressionVolumeSell;
        this.assetsQuotes[posAssetQuotes].theoricalLevel = theoricalLevel;
        this.assetsQuotes[posAssetQuotes].theoricalVolumeBuy =
          theoricalVolumeBuy;
        this.assetsQuotes[posAssetQuotes].theoricalVolumeSell =
          theoricalVolumeSell;
        this.assetsQuotes[posAssetQuotes].state = state;
        this.assetsQuotes[posAssetQuotes].active = true;

        return true;
      });

    if (indDateTime) {
      const { datetimes, outliers } = this.removeDateTimeQuotesOutliers(
        quoteDateTime,
        60000, // 1 minute = 60000 milliseconds
      );
      const qte = datetimes.length;
      const sum = datetimes.reduce((a, b) => {
        return a + b;
      });

      if (qte > 0) {
        this.diffTime = this.calculateDiffTime(now, new Date(sum / qte));

        if (this.listenerCount('quotedifftime') > 0 && this.diffTime) {
          for (let i = 0; i < this.assetsQuotes.length; i++) {
            const outlier = outliers
              ? outliers.find(o => o.asset === this.assetsQuotes[i].asset.code)
              : undefined;

            if (outlier) {
              this.assetsQuotes[i].datetime = this.assetsQuotes[i].active
                ? new Date(outlier.datetime)
                : undefined;
            } else {
              this.assetsQuotes[i].datetime =
                this.assetsQuotes[i].active && this.assetsQuotes[i].datetime
                  ? this.getAdjustedDatetime(now)
                  : undefined;
            }
          }
          this.emit('quotedifftime', this.diffTime);
        }
      }
    }

    data = null;
  }

  public async writeData(): Promise<void> {
    // Check if shutdown time has reached
    const now = this.getAdjustedDatetime(new Date());
    if (
      this.diffTime &&
      process.env.TRYDLOADER_SHUTDOWN_TIME &&
      now.getTime() >
        new Date(
          `${this.dateRef.getFullYear()}-${String(
            this.dateRef.getMonth() + 1,
          ).padStart(2, '0')}-${String(this.dateRef.getDate()).padStart(
            2,
            '0',
          )} ${process.env.TRYDLOADER_SHUTDOWN_TIME}-03`,
        ).getTime()
    ) {
      if (this.listenerCount('shutdowntime') > 0)
        this.emit('shutdowntime', now);
      /* else {
        const error = `[${this.name}] Missing "shutdowntime" event listener. Exception thrown!`;
        this.logger.error(error);
        throw new Error(error);
      } */
      return;
    }

    const insertParams: any[] = [];
    const qLast = await this.pool.query({
      text: `SELECT 
      distinct on (asset) asset, datetime, open, high, 
      low, last, vwap, quantity, volume, 
      "aggression-quantity-buy" aggqtybuy, "aggression-quantity-sell" aggqtysell, 
      "aggression-volume-buy" aggvolbuy, "aggression-volume-sell" aggvolsell, 
      "theorical-level" theoricallevel, "theorical-volume-buy" theoricalvolumebuy, 
      "theorical-volume-sell" theoricalvolumesell, state 
      FROM "b3-assetsquotes" 
      WHERE datetime::DATE=$1::DATE ORDER BY asset ASC, datetime DESC`,
      values: [now],
    });

    // eslint-disable-next-line no-restricted-syntax
    for await (const quotes of this.assetsQuotes) {
      if (!quotes.active || !quotes.datetime || quotes.state === 'SUSPENSO')
        continue;

      const posLast = qLast.rows.map(q => q.asset).indexOf(quotes.asset.code);
      if (
        posLast < 0 ||
        (posLast >= 0 &&
          (quotes.open !== Number(qLast.rows[posLast].open) ||
            quotes.high !== Number(qLast.rows[posLast].high) ||
            quotes.low !== Number(qLast.rows[posLast].low) ||
            quotes.last !== Number(qLast.rows[posLast].last) ||
            quotes.vwap !== Number(qLast.rows[posLast].vwap) ||
            quotes.quantity !== Number(qLast.rows[posLast].quantity) ||
            quotes.volume !== Number(qLast.rows[posLast].volume) ||
            quotes.aggressionQuantityBuy !==
              Number(qLast.rows[posLast].aggqtybuy) ||
            quotes.aggressionQuantitySell !==
              Number(qLast.rows[posLast].aggqtysell) ||
            quotes.aggressionVolumeBuy !==
              Number(qLast.rows[posLast].aggvolbuy) ||
            quotes.aggressionVolumeSell !==
              Number(qLast.rows[posLast].aggvolsell) ||
            quotes.theoricalLevel !==
              Number(qLast.rows[posLast].theoricallevel) ||
            quotes.theoricalVolumeBuy !==
              Number(qLast.rows[posLast].theoricalvolumebuy) ||
            quotes.theoricalVolumeSell !==
              Number(qLast.rows[posLast].theoricalvolumesell) ||
            quotes.state !== qLast.rows[posLast].state))
      ) {
        insertParams.push([
          quotes.asset.code,
          quotes.datetime,
          quotes.open || null,
          quotes.high || null,
          quotes.low || null,
          quotes.last || null,
          quotes.vwap || null,
          quotes.quantity || null,
          quotes.volume || null,
          quotes.aggressionQuantityBuy || null,
          quotes.aggressionQuantitySell || null,
          quotes.aggressionVolumeBuy || null,
          quotes.aggressionVolumeSell || null,
          quotes.theoricalLevel || null,
          quotes.theoricalVolumeBuy || null,
          quotes.theoricalVolumeSell || null,
          quotes.state,
          !this.diffTime,
        ]);
      }
    }
    if (insertParams.length === 0) return;

    await this.pool.query(
      format(
        `INSERT INTO "b3-assetsquotes" (asset, datetime, open, high, low, last, 
        vwap, quantity, volume, "aggression-quantity-buy", "aggression-quantity-sell",
        "aggression-volume-buy", "aggression-volume-sell", "theorical-level", 
        "theorical-volume-buy", "theorical-volume-sell", state, auction) VALUES  %L`,
        insertParams,
      ),
      [],
    );

    if (!this.isSameDay(this.dateRef, new Date())) this.diffTime = undefined; // Force clock sync for replay date
  }

  public async updateDatetimeDiff(diffTime: number): Promise<number> {
    if (!diffTime || diffTime === 0) return 0;
    this.diffTime = diffTime;

    const qUpdate = await this.pool.query(
      `UPDATE "b3-assetsquotes" SET 
      datetime=TO_TIMESTAMP((EXTRACT(EPOCH FROM datetime::TIMESTAMPTZ)*1000 - $1)/1000),
      auction=FALSE
      WHERE auction=TRUE`,
      [this.diffTime],
    );

    return qUpdate.rowCount;
  }

  public async cleanAuctionData(): Promise<number> {
    const qDel = await this.pool.query(
      `DELETE FROM "b3-assetsquotes" WHERE auction=TRUE`,
      [],
    );

    return qDel.rowCount;
  }

  private getTrydQuoteState(state: string): string {
    switch (state) {
      case 'LEILAO':
        return TTrydQuoteState.AUCTION;
      case 'PRORROGACAO DE LEILAO':
        return TTrydQuoteState.AUCTION_EXTENTION;
      case 'NORMAL':
        return TTrydQuoteState.TRADING;
      case 'SUSPENSO':
        return TTrydQuoteState.FROZEN;
      default:
        return TTrydQuoteState.UNKNOWN;
    }
  }

  private getTrydTheoricalIndNetVolume(ind: string): string {
    switch (ind) {
      case 'V':
        return TTheoricalIndNetVolume.SELL;
      case 'C':
        return TTheoricalIndNetVolume.BUY;
      case '':
        return TTheoricalIndNetVolume.EVEN;
      default:
        return ind;
    }
  }

  private removeDateTimeQuotesOutliers(
    datetimeQuotes: { asset: string; datetime: number }[],
    threshold: number,
  ): { datetimes: number[]; outliers?: { asset: string; datetime: number }[] } {
    if (datetimeQuotes.length <= 1)
      return { datetimes: datetimeQuotes.map(a => a.datetime) };
    if (datetimeQuotes.length === 2) {
      return datetimeQuotes[1].datetime > datetimeQuotes[0].datetime
        ? { datetimes: [datetimeQuotes[1].datetime] }
        : { datetimes: [datetimeQuotes[0].datetime] };
    }
    const values = datetimeQuotes.sort((a, b) => a.datetime - b.datetime);
    const median = values[Math.floor(values.length / 2)].datetime;

    return {
      datetimes: datetimeQuotes
        .map(a => a.datetime)
        .filter(a => Math.abs(a - median) < Math.abs(threshold)),
      outliers: datetimeQuotes.filter(
        a => Math.abs(a.datetime - median) >= Math.abs(threshold),
      ),
    };
  }
}

export { TTrydQuote, IAssetQuotes };
