/* eslint-disable no-continue */
import { Pool } from 'pg';
import format from 'pg-format';
import { Logger } from 'tslog';
import DataRTDLoader, { IAsset } from './dataRTDLoader';

const _NAME = 'AssetsBooksRTDLoader';

/*
// Querying book
select q.datetime, q.asset, booktype."buyVolume", booktype."buyLevel", booktype."sellLevel", booktype."sellVolume"  from 
(select * from "b3-assetsbooks" where asset = 'DOLF23' order by datetime desc limit 1) q,
jsonb_to_recordset(q."book-price") as booktype("buyLevel" decimal, "buyOffers" int, "buyVolume" int, "sellLevel" decimal, "sellOffers" int, "sellVolume" int)
*/

interface IBookLevel {
  buyOffers: number;
  buyVolume: number;
  buyLevel: number;
  sellOffers: number;
  sellVolume: number;
  sellLevel: number;
}

interface IAssetBook {
  asset: IAsset;
  datetime: Date | undefined;
  active: boolean;
  book: IBookLevel[] | undefined;
}

export default class assetsBooksRTDLoader extends DataRTDLoader {
  private assetsBooks: IAssetBook[];

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

    this.assetsBooks = assets.map(a => {
      return {
        asset: a,
        datetime: undefined,
        book: undefined,
        active: false,
      };
    });
  }

  public async startListening(): Promise<void> {
    const itens: string[] = [];
    this.assetsBooks.forEach(a => {
      const asset = a.asset.codeReplay ? a.asset.codeReplay : a.asset.code;
      for (
        let line = 0;
        line < Number(process.env.TRYDLOADER_RTD_BOOK_LINES || '20') - 1;
        line++
      ) {
        itens.push(`LVL2$S|1|${asset}|${line}|0`);
        itens.push(`LVL2$S|1|${asset}|${line}|1`);
        itens.push(`LVL2$S|1|${asset}|${line}|2`);
        itens.push(`LVL2$S|1|${asset}|${line}|3`);
        itens.push(`LVL2$S|1|${asset}|${line}|4`);
        itens.push(`LVL2$S|1|${asset}|${line}|5`);
      }
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
      const posLastLine = data.lastIndexOf('#LVL2!');
      if (posLastLine < 0) return;

      this._bufferData = (this._bufferData || '').concat(
        data.substring(posLastLine + 1),
      );
      data = data.substring(0, posLastLine);

      if (data.substr(0, 5) === 'LVL2!') data = data.substr('LVL2!'.length); // Removes 'LVL2!' at begining
    } else {
      data =
        data.substr(0, 5) === 'LVL2!'
          ? data.substr('LVL2!'.length, data.length - ('LVL2!'.length + 1))
          : data.substr(0, data.length - 1); // Removes 'LVL2!' at begining and '#' at end

      this._bufferData = null;
    }

    const now = new Date();

    data
      .replace(/(#LVL2!)/g, '#')
      .split('#')
      .every(assetbook => {
        const book: IBookLevel[] = [];
        const bookline = assetbook.split('|');
        let asset = bookline[0].trim().toUpperCase();
        const posAssetBook = this.assetsBooks
          .map(a => (a.asset.codeReplay ? a.asset.codeReplay : a.asset.code))
          .indexOf(asset);

        if (posAssetBook < 0) {
          if (this.listenerCount('error') > 0)
            this.emit(
              'error',
              new Error(
                `[${this.name}] loadData() - Unknown asset: ${asset} - book: ${assetbook}`,
              ),
            );
          return false;
        }
        asset = this.assetsBooks[posAssetBook].asset.code;

        for (let i = 1; i + 5 < bookline.length; i += 6) {
          let j = i;
          let line = bookline[j].trim();
          let bookcolumn = line.split(';');
          let buyOffers;
          if (line === '') buyOffers = 0;
          else if (bookcolumn.length !== 4) {
            if (this.listenerCount('error') > 0)
              this.emit(
                'error',
                new Error(
                  `[${this.name}] loadData() - Unknown data line format [buyOffers] - asset: ${asset} - i/j: ${i}/${j} - bookline: ${line}`,
                ),
              );
            return false;
          } else buyOffers = Number(bookcolumn[3]);

          j = i + 1;
          line = bookline[j].trim();
          bookcolumn = line.split(';');
          let buyVolume;
          if (line === '') buyVolume = 0;
          else if (bookcolumn.length !== 4) {
            if (this.listenerCount('error') > 0)
              this.emit(
                'error',
                new Error(
                  `[${this.name}] loadData() - Unknown data line format [buyVolume] - asset: ${asset} - i/j: ${i}/${j} - bookline: ${line}`,
                ),
              );
            return false;
          } else buyVolume = Number(bookcolumn[3]);

          j = i + 2;
          line = bookline[j].trim();
          bookcolumn = line.split(';');
          let buyLevel;
          if (line === '') buyLevel = 0;
          else if (bookcolumn.length !== 4) {
            if (this.listenerCount('error') > 0)
              this.emit(
                'error',
                new Error(
                  `[${this.name}] loadData() - Unknown data line format [buyLevel] - asset: ${asset} - i/j: ${i}/${j} - bookline: ${line}`,
                ),
              );
            return false;
          } else buyLevel = Number(bookcolumn[3].replace(',', '.'));

          j = i + 3;
          line = bookline[j].trim();
          bookcolumn = line.split(';');
          let sellLevel;
          if (line === '') sellLevel = 0;
          else if (bookcolumn.length !== 4) {
            if (this.listenerCount('error') > 0)
              this.emit(
                'error',
                new Error(
                  `[${this.name}] loadData() - Unknown data line format [sellLevel] - asset: ${asset} - i/j: ${i}/${j} - bookline: ${line}`,
                ),
              );
            return false;
          } else sellLevel = Number(bookcolumn[3].replace(',', '.'));

          j = i + 4;
          line = bookline[j].trim();
          bookcolumn = line.split(';');
          let sellVolume;
          if (line === '') sellVolume = 0;
          else if (bookcolumn.length !== 4) {
            if (this.listenerCount('error') > 0)
              this.emit(
                'error',
                new Error(
                  `[${this.name}] loadData() - Unknown data line format [sellVolume] - asset: ${asset} - i/j: ${i}/${j} - bookline: ${line}`,
                ),
              );
            return false;
          } else sellVolume = Number(bookcolumn[3]);

          j = i + 5;
          line = bookline[j].trim();
          bookcolumn = line.split(';');
          let sellOffers;
          if (line === '') sellOffers = 0;
          else if (bookcolumn.length !== 4) {
            if (this.listenerCount('error') > 0)
              this.emit(
                'error',
                new Error(
                  `[${this.name}] loadData() - Unknown data line format [sellOffers] - asset: ${asset} - i/j: ${i}/${j} - bookline: ${line}`,
                ),
              );
            return false;
          } else sellOffers = Number(bookcolumn[3]);

          if (asset !== '' && (buyOffers > 0 || sellOffers > 0))
            book.push({
              buyOffers,
              buyVolume,
              buyLevel,
              sellOffers,
              sellVolume,
              sellLevel,
            });
        }

        if (book.length === 0) return true; // read next asset

        this.assetsBooks[posAssetBook].datetime = this.getAdjustedDatetime(now);
        this.assetsBooks[posAssetBook].book = book;
        this.assetsBooks[posAssetBook].active = true;

        return true;
      });

    data = null;
  }

  public async writeData(): Promise<void> {
    const insertParams: any[] = [];
    const qLast = await this.pool.query({
      text: `SELECT distinct on (asset) asset, datetime, "book-price" book 
      FROM "b3-assetsbooks" WHERE datetime::DATE=$1::DATE 
      ORDER BY asset ASC, datetime DESC`,
      values: [this.dateRef],
    });

    // eslint-disable-next-line no-restricted-syntax
    for await (const assetBook of this.assetsBooks) {
      if (!assetBook.active) continue;

      const posLast = qLast.rows
        .map(q => q.asset)
        .indexOf(assetBook.asset.code);
      if (
        posLast < 0 ||
        (posLast >= 0 &&
          !this.booksAreEqual(
            assetBook.book!,
            <IBookLevel[]>qLast.rows[posLast].book,
          ))
      ) {
        insertParams.push([
          assetBook.asset.code,
          assetBook.datetime,
          `${JSON.stringify(assetBook.book)}`,
          !this.diffTime,
        ]);
      }
    }
    if (insertParams.length === 0) return;

    await this.pool.query(
      format(
        `INSERT INTO "b3-assetsbooks" (asset, datetime, "book-price", auction) VALUES  %L`,
        insertParams,
      ),
      [],
    );
  }

  private booksAreEqual(book1: IBookLevel[], book2: IBookLevel[]): boolean {
    if (book1.length !== book2.length) return false;

    for (let i = 0; i < book1.length; i++) {
      if (
        book1[i].buyLevel !== book2[i].buyLevel ||
        book1[i].buyOffers !== book2[i].buyOffers ||
        book1[i].buyVolume !== book2[i].buyVolume ||
        book1[i].sellLevel !== book2[i].sellLevel ||
        book1[i].sellOffers !== book2[i].sellOffers ||
        book1[i].sellVolume !== book2[i].sellVolume
      )
        return false;
    }

    return true;
  }

  public async updateDatetimeDiff(diffTime: number): Promise<number> {
    if (!diffTime || diffTime === 0) return 0;
    this.diffTime = diffTime;

    const qUpdate = await this.pool.query(
      `UPDATE "b3-assetsbooks" SET 
      datetime=TO_TIMESTAMP((EXTRACT(EPOCH FROM datetime::TIMESTAMPTZ)*1000 - $1)/1000),
      auction=FALSE
      WHERE auction=TRUE`,
      [this.diffTime],
    );

    return qUpdate.rowCount;
  }

  public async cleanAuctionData(): Promise<number> {
    const qDel = await this.pool.query(
      `DELETE FROM "b3-assetsbooks" WHERE auction=TRUE`,
      [],
    );

    return qDel.rowCount;
  }
}

export { IBookLevel, IAssetBook };
