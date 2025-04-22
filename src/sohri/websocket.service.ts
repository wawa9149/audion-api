// src/sohri/websocket.service.ts
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as WebSocket from 'ws';
import { ConfigService } from '@nestjs/config';

export interface EpdResponse {
  session_id: string;
  status: number;
  speech_score?: number;
}

@Injectable()
export class WebSocketService implements OnModuleDestroy {
  private readonly logger = new Logger(WebSocketService.name);

  private ws?: WebSocket;
  private reconnectTimeout?: NodeJS.Timeout;
  private heartbeatInterval?: NodeJS.Timeout;
  private isManualClose = false;

  /** EPD 메시지 콜백 */
  private onEpdMessageCallback?: (data: EpdResponse) => void;

  constructor(private readonly configService: ConfigService) { }

  /**
   * 앱 시작 시, 또는 재연결 시 호출
   */
  connect(): void {
    const url = this.configService.get<string>('WS_URL');
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.logger.debug('EPD WebSocket already connected');
      return;
    }

    this.isManualClose = false;
    this.logger.log(`Connecting to EPD WebSocket: ${url}`);

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.logger.log('EPD WebSocket connected');
      this.startHeartbeat();
      // 만약 이전에 예약된 재연결 타이머가 있다면 취소
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = undefined;
      }
    });

    this.ws.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg.toString()) as EpdResponse;
        this.logger.debug(`EPD WebSocket message: ${JSON.stringify(parsed)}`);
        this.onEpdMessageCallback?.(parsed);
      } catch (err: any) {
        this.logger.error('Failed to parse EPD message', err);
      }
    });

    this.ws.on('pong', () => {
      this.logger.debug('EPD WebSocket pong');
    });

    this.ws.on('error', (err) => {
      this.logger.error('EPD WebSocket error', err.message);
      // 에러 발생 시 close 이벤트도 함께 트리거 되므로 재연결 스케줄링은 close 쪽에서 처리
    });

    this.ws.on('close', (code, reason) => {
      this.logger.warn(`EPD WebSocket closed (code=${code}, reason=${reason.toString()})`);
      this.stopHeartbeat();
      if (!this.isManualClose) {
        this.scheduleReconnect();
      }
    });
  }

  /**
   * 서버 종료 시(혹은 모듈 언마운트 시) 호출
   */
  onModuleDestroy() {
    this.isManualClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.ws?.close();
  }

  /**
   * EPD로 바이너리 데이터 전송
   */
  sendMessage(sessionId: string, data: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.error('WebSocket not open, cannot send message');
      return;
    }
    this.ws.send(data, (err) => {
      if (err) this.logger.error('Failed to send EPD message', err.message);
    });
  }

  /**
   * SohriService가 등록할 콜백
   */
  setEpdCallback(cb: (res: EpdResponse) => void) {
    this.onEpdMessageCallback = cb;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 내부 helper: 자동 재연결 & heartbeat
  // ──────────────────────────────────────────────────────────────────────────

  /** 일정 시간 후 재연결 시도 */
  private scheduleReconnect() {
    const delay = this.configService.get<number>('WS_RECONNECT_INTERVAL') ?? 1000;
    if (this.reconnectTimeout) return;
    this.logger.log(`Reconnecting to EPD WebSocket in ${delay}ms...`);
    this.reconnectTimeout = setTimeout(() => this.connect(), delay);
  }

  /** 주기적으로 ping 을 보내서 연결 유지 확인 */
  private startHeartbeat() {
    this.stopHeartbeat();
    const interval = this.configService.get<number>('WS_HEARTBEAT_INTERVAL') ?? 30000;
    this.logger.debug(`Starting heartbeat (ping every ${interval}ms)`);
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.logger.debug('Sending WebSocket ping');
        this.ws.ping();
      }
    }, interval);
  }

  /** heartbeat 중단 */
  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }
}
