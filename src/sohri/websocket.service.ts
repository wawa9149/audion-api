// src/sohri/websocket.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as WebSocket from 'ws';
import { AudioStreamResponseStatus } from './sohri.service';

@Injectable()
export class WebSocketService {
  private readonly logger = new Logger(WebSocketService.name);
  private ws: WebSocket;

  constructor(private readonly configService: ConfigService) { }

  connect(onMessage: (status: AudioStreamResponseStatus) => void): void {
    const url = this.configService.get<string>('WS_URL');
    this.ws = new WebSocket(url);

    this.ws.on('open', () => this.logger.log('WebSocket connected'));

    this.ws.on('message', (msg) => {
      const message = msg.toString();
      this.logger.log(`📥 WebSocket message received: ${message}`);

      switch (message) {
        case 'SPEECH':
          return onMessage(AudioStreamResponseStatus.SPEECH);
        case 'END':
          return onMessage(AudioStreamResponseStatus.END);
        case 'PAUSE':
          return onMessage(AudioStreamResponseStatus.PAUSE);
        case 'WAITING':
          return onMessage(AudioStreamResponseStatus.WAITING);
        case 'TIMEOUT':
          return onMessage(AudioStreamResponseStatus.TIMEOUT);
        default:
          return onMessage(AudioStreamResponseStatus.ERROR);
      }
    });

    this.ws.on('close', () => this.logger.log('WebSocket closed'));
    this.ws.on('error', (err) => this.logger.error('WebSocket error', err.message));
  }

  send(ttsStatus: number, content: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.error('WebSocket is not open');
      return;
    }
    const buffer = Buffer.concat([Buffer.from([ttsStatus]), content]);
    this.ws.send(buffer);
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }
}
