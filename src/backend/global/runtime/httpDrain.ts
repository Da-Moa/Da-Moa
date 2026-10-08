import { Injectable } from '@nestjs/common';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';

@Injectable()
export class HttpDrain {
  private server?: Server;
  private readonly pending = new Set<Socket>();
  private readonly accepted = (socket: Socket) => {
    this.pending.add(socket);
    socket.once('close', () => this.pending.delete(socket));
  };
  private readonly requested = (request: IncomingMessage) => {
    this.pending.delete(request.socket);
  };

  attach(server: Server) {
    this.server = server;
    server.on('connection', this.accepted);
    server.on('request', this.requested);
    server.on('upgrade', this.requested);
  }

  close() {
    this.server?.off('connection', this.accepted);
    this.server?.off('request', this.requested);
    this.server?.off('upgrade', this.requested);
    // Node's HTTP close waits on browser preconnects that have never sent a request.
    // Active HTTP requests finish through Nest's normal server shutdown.
    for (const socket of this.pending) socket.destroy();
    this.pending.clear();
    this.server = undefined;
  }
}
