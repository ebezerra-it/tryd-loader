interface Clients {
    services: any;
    connect():any;
    disconnect():any;
    pause():any;
    resume():any;
    execute(command?: string, timeout?: number): any;
    poke(data?: string, timeout?: number): any;
    request(format?: number, timeout?: number): any;
    startAdvise(format?: number, hot?: boolean, timeout?: number): any;
    stopAdvise(timeout?: number): any;
    dispose():any;
    service():any;
    topic():any;
    isConnected():any;
    isPaused():any;
    on(event: string, cb: any): void;
    removeListener(event: string, cb: any): void;
    removeAllListeners(events: string[]): void;
}
export function createClient(service: any, topic: any): Clients;
export function createClients(services: any): Clients;
export function createServer(service: any): any;
