// src/sohri/websocket.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as WebSocket from 'ws';

@Injectable()
export class WebSocketService {
  private readonly logger = new Logger(WebSocketService.name);
  private ws: WebSocket;

  constructor(private readonly configService: ConfigService) { }

  connect(): void {
    const url = this.configService.get<string>('WS_URL');
    this.ws = new WebSocket(url);

    this.ws.on('open', () => this.logger.log('WebSocket connected'));
    this.ws.on('close', () => this.logger.log('WebSocket closed'));
    this.ws.on('error', (err) => this.logger.error('WebSocket error', err.message));
  }

  disconnect(): void {
    this.logger.debug('Disconnecting WebSocket...');
    this.ws?.close();
    this.ws = null;
  }

  async handleMessage(chunk: Buffer): Promise<{ status: number; speech_score: number }> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.logger.error('WebSocket is not open');
        return reject(new Error('WebSocket not open'));
      }

      const onMessage = (msg: WebSocket.Data) => {
        try {
          const parsed = JSON.parse(msg.toString());
          this.logger.debug(`📥 WebSocket message received: ${msg.toString()}`);
          this.ws.off('message', onMessage);
          resolve(parsed);
        } catch (err) {
          this.logger.error('Failed to parse WebSocket message:', err.message);
          reject(err);
        }
      };

      this.ws.on('message', onMessage);
      this.ws.send(chunk);
    });
  }

  send(chunk: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    }
  }
}
