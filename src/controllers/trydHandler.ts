/* eslint-disable no-async-promise-executor */
/* eslint-disable no-nested-ternary */
import robot from 'robotjs';
import { EventEmitter } from 'events';
import { exec } from 'child_process';

enum TConnectionStatus {
  ONLINE = 'ONLINE',
  OFFLINE = 'OFFLINE',
  UNKNOWN = 'UNKNOWN',
}

interface ITrydHandlerConfig {
  TRYD_OPEN_DELAY: number;
  CONNECTION_CHECKER_INTERVAL: number;
  CONNECTION_CHECKER_TIMEOUT: number;
  CONNECTION_BROKEN_RECHECK: number;
  ACTION_DELAY: number;
  TRYD_BACKGROUND_COLOR: string;
}

const TRYD_OPEN_DELAY = 15;
const CONNECTION_CHECKER_INTERVAL = 1;
const CONNECTION_CHECKER_TIMEOUT = 10;
const CONNECTION_BROKEN_RECHECK = 5;
const ACTION_DELAY = 2;
const TRYD_BACKGROUND_COLOR = '191919';

function sleep(s: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, s * 1000));
}

function processRunning(query: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    exec('tasklist', (err, stdout, stderr) => {
      if (stderr)
        reject(
          new Error(
            `[TrydHandler] Failed to execute tasklist command: ${stderr.toString()}`,
          ),
        );
      resolve(stdout.toLowerCase().indexOf(query.toLowerCase()) > -1);
    });
  });
}

interface ITrydEventListener {
  event: string;
  timer: NodeJS.Timer;
  action: (event: string) => Promise<void>;
}

export default class TrydHandler extends EventEmitter {
  public robot;

  private config: ITrydHandlerConfig;

  private guestScreen: { width: number; height: number };

  private eventListeners: ITrydEventListener[];

  constructor(config?: {
    TRYD_OPEN_DELAY?: number;
    CONNECTION_CHECKER_INTERVAL?: number;
    CONNECTION_CHECKER_TIMEOUT?: number;
    CONNECTION_BROKEN_RECHECK?: number;
    ACTION_DELAY?: number;
    TRYD_BACKGROUND_COLOR?: string;
  }) {
    if (process.platform !== 'win32')
      throw new Error(`[TrydHandler] Incompatible OS: ${process.platform}`);

    super();
    this.config = {
      TRYD_OPEN_DELAY: (config && config.TRYD_OPEN_DELAY) || TRYD_OPEN_DELAY,
      CONNECTION_CHECKER_INTERVAL:
        (config && config.CONNECTION_CHECKER_INTERVAL) ||
        CONNECTION_CHECKER_INTERVAL,
      CONNECTION_CHECKER_TIMEOUT:
        (config && config.CONNECTION_CHECKER_TIMEOUT) ||
        CONNECTION_CHECKER_TIMEOUT,
      CONNECTION_BROKEN_RECHECK:
        (config && config.CONNECTION_BROKEN_RECHECK) ||
        CONNECTION_BROKEN_RECHECK,
      ACTION_DELAY: (config && config.ACTION_DELAY) || ACTION_DELAY,
      TRYD_BACKGROUND_COLOR:
        (config && config.TRYD_BACKGROUND_COLOR) || TRYD_BACKGROUND_COLOR,
    };
    this.robot = robot;
    this.guestScreen = robot.getScreenSize();
    this.eventListeners = [];
  }

  private createListeners(): void {
    const event = 'ConnectionBroken';
    const action = async (eventName: string) => {
      const trydEvent = this.eventListeners.find(e => e.event === eventName);
      if (!trydEvent)
        throw new Error(
          `[TrydHandler] Can't find event ${eventName} in trydEvents: ${JSON.stringify(
            this.eventListeners,
            null,
            4,
          )}`,
        );
      clearInterval(trydEvent.timer);

      if (this.connectionStatus() !== TConnectionStatus.ONLINE) {
        await sleep(this.config.CONNECTION_BROKEN_RECHECK);
        if (this.connectionStatus() !== TConnectionStatus.ONLINE)
          this.emit(event);
      }
      trydEvent.timer = setInterval(
        trydEvent.action,
        CONNECTION_CHECKER_INTERVAL * 1000,
        trydEvent.event,
      );
    };

    this.eventListeners.push({
      event,
      timer: setInterval(action, CONNECTION_CHECKER_INTERVAL * 1000, event),
      action,
    });
  }

  private stopListeners(eventName?: string): void {
    this.eventListeners.forEach((e, index, eventList) => {
      if (e.event === eventName || !eventName) {
        clearInterval(e.timer);
        eventList.splice(index, 1);
      }
    });
  }

  public async isRunning(): Promise<boolean> {
    return processRunning('javaw.exe');
  }

  public async open(): Promise<void> {
    if (process.env.NODE_ENV === 'PROD') {
      this.robot.moveMouse(72, this.guestScreen.height - 22);
      this.robot.mouseClick();

      await sleep(TRYD_OPEN_DELAY);
      if (!this.isRunning())
        throw new Error('[TrydHandler] Unable to launch TRYD');

      // wait for online connection
      await this.waitForOnlineConnection();

      // close child windows
      await this.closeChildWindows();

      // close update notification alert
      await this.closeNotifications();
    }

    // create listeners
    this.createListeners();
  }

  public async close(): Promise<void> {
    this.stopListeners();

    if (process.env.NODE_ENV !== 'PROD') return;

    this.robot.moveMouse(this.guestScreen.width - 25, 10);
    this.robot.mouseClick();
    await sleep(ACTION_DELAY);
  }

  private async closeChildWindows(): Promise<void> {
    await new Promise(async (resolve, reject) => {
      setTimeout(() => {
        reject(new Error('[TrydHandler] Unable to close Tryd child windows'));
      }, CONNECTION_CHECKER_TIMEOUT * 1000);

      try {
        while (
          this.robot.getPixelColor(
            this.guestScreen.width / 2,
            this.guestScreen.height / 2,
          ) !== TRYD_BACKGROUND_COLOR
        ) {
          this.robot.keyTap('escape');
          await sleep(ACTION_DELAY);
        }
      } catch (err) {
        resolve(err);
      }

      resolve();
    });
  }

  private async closeNotifications(): Promise<void> {
    await new Promise(async (resolve, reject) => {
      setTimeout(() => {
        reject(new Error('[TrydHandler] Unable to close notification alerts'));
      }, CONNECTION_CHECKER_TIMEOUT * 1000);

      while (
        this.robot.getPixelColor(
          this.guestScreen.width - 15,
          this.guestScreen.height - 68,
        ) !== TRYD_BACKGROUND_COLOR
      ) {
        this.robot.moveMouse(
          this.guestScreen.width - 15,
          this.guestScreen.height - 168,
        );
        this.robot.mouseClick();
        await sleep(ACTION_DELAY);
      }

      resolve();
    });
  }

  private async waitForOnlineConnection(): Promise<void> {
    await new Promise((resolve, reject) => {
      const waitForOnlineConnection = setInterval(async () => {
        if (this.connectionStatus() === TConnectionStatus.ONLINE) {
          resolve();
        }
      }, CONNECTION_CHECKER_INTERVAL * 1000);

      setTimeout(() => {
        clearInterval(waitForOnlineConnection);
        reject(new Error('[TrydHandler] Open Tryd connection error'));
      }, CONNECTION_CHECKER_TIMEOUT * 1000);
    });
  }

  private dataFeedStarted(): boolean {
    const colorStarted = this.robot.getPixelColor(75, 60);
    if (colorStarted === 'f34336') return true;
    if (colorStarted === '4caf50') return false;
    throw new Error(
      `[TrydHandler] Unknown startDataFeed color: ${colorStarted}`,
    );
  }

  private async startDataFeed(): Promise<void> {
    if (!this.dataFeedStarted()) {
      this.robot.moveMouse(75, 60);
      this.robot.mouseClick();

      await sleep(ACTION_DELAY);
      if (!this.dataFeedStarted)
        throw new Error('[TrydHandler] Unable to start Data Feed');
    }
  }

  private DDEStarted(): boolean {
    // start DDE 117, 49 on: 304c63 off: 3c3c3c
    const colorStarted = this.robot.getPixelColor(117, 49);
    if (colorStarted === '304c63') return true;
    if (colorStarted === '364450') return false;
    throw new Error(`[TrydHandler] Unknown startDDE color: ${colorStarted}`);
  }

  private async startDDE(): Promise<void> {
    if (!this.DDEStarted()) {
      robot.moveMouse(105, 60);
      robot.mouseClick();

      await sleep(ACTION_DELAY);
      if (!this.DDEStarted)
        throw new Error('[TrydHandler] Unable to start DDE');
    }
  }

  public async startDataListening(): Promise<void> {
    if (process.env.NODE_ENV === 'PROD') {
      await this.startDataFeed();
      await this.startDDE();
    }
  }

  public connectionStatus(): TConnectionStatus {
    if (process.env.NODE_ENV !== 'PROD') return TConnectionStatus.ONLINE;

    return this.robot.getPixelColor(14, this.guestScreen.height - 58) ===
      '58ac2c'
      ? TConnectionStatus.ONLINE
      : this.robot.getPixelColor(14, this.guestScreen.height - 58) === 'c92627'
      ? TConnectionStatus.OFFLINE
      : TConnectionStatus.UNKNOWN;
  }
}

export { sleep, processRunning, TConnectionStatus };
