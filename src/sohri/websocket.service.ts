// websocket.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as WebSocket from 'ws';
import { ConfigService } from '@nestjs/config';

export interface EpdResponse {
  session_id: string;
  status: number;
  speech_score?: number;
}

@Injectable()
export class WebSocketService {
  private readonly logger = new Logger(WebSocketService.name);
  private ws: WebSocket;

  constructor(private readonly configService: ConfigService) { }

  private onEpdMessageCallback?: (data: EpdResponse) => void;

  connect(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.logger.debug('EPD WebSocket already connected');
      return;
    }
    this.ws = new WebSocket(this.configService.get<string>('WS_URL'));
    this.ws.on('error', (err) => this.logger.error('WebSocket error', err.message));
    this.ws.on('open', () => this.logger.log('EPD WebSocket connected'));
    this.ws.on('message', (msg) => {
      // JSON 파싱
      const parsed = JSON.parse(msg.toString()) as EpdResponse;
      this.logger.log(`EPD WebSocket message: ${JSON.stringify(parsed)}`);
      this.onEpdMessageCallback?.(parsed);
    });
    this.ws.on('close', () => this.logger.log('EPD WebSocket closed'));
    this.ws.on('error', (err) => this.logger.error('EPD WebSocket error', err));
  }

  sendMessage(sessionId: string, data: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.error('WebSocket not open');
      return;
    }
    // 그냥 바이너리 전송 or 특정 프로토콜로 JSON 래핑
    this.ws.send(data);
  }

  setEpdCallback(cb: (res: EpdResponse) => void) {
    this.onEpdMessageCallback = cb;
  }
}
