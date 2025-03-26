// src/sohri/sohri.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { Subject, Observable } from 'rxjs';
import { Socket, Server } from 'socket.io';
import { FileService } from './file.service';
import { SpeechService } from './speech.service';
import { WebSocketService } from './websocket.service';

export enum AudioStreamResponseStatus {
  PAUSE = 1,
  END = 2,
  SPEECH = 3,
  TIMEOUT = 4,
  WAITING = 5,
  ERROR = 6,
}

@Injectable()
export class SohriService {
  private readonly logger = new Logger(SohriService.name);

  private clientMap = new Map<string, Socket>();        // turnId ↔ client
  private tempFiles = new Map<string, string>();        // turnId ↔ temp PCM file
  private deliverySubject = new Subject<any>();
  private server: Server;

  constructor(
    private readonly fileService: FileService,
    private readonly speechService: SpeechService,
    private readonly wsService: WebSocketService,
  ) { }

  setServer(server: Server) {
    this.server = server;
  }

  getClientByTurnId(turnId: string): Socket | undefined {
    return this.clientMap.get(turnId);
  }

  getDeliveryStream(): Observable<any> {
    return this.deliverySubject.asObservable();
  }

  /**
   * TURN_START, TURN_END, etc 처리
   */
  handleEvent(data: { event: number }, client: Socket): string {
    const { event } = data;

    switch (event) {
      case 10: // TURN_START
        const turnId = uuidv4();
        const tempFile = this.fileService.prepareTempFile(turnId);
        this.tempFiles.set(turnId, tempFile);
        this.clientMap.set(turnId, client);
        this.logger.log(`TURN_START: ${turnId}`);
        this.wsService.connect((status) => {
          this.logger.log(`WebSocket 상태 수신: ${AudioStreamResponseStatus[status]}`);
          if (status === AudioStreamResponseStatus.END) {
            const file = this.tempFiles.get(turnId);
            if (file) {
              this.speechService.sendSpeechResponse(turnId, file, false)
                .then((result) => {
                  this.deliverySubject.next(result);
                })
                .catch((err) => this.logger.error('STT 실패:', err.message));
            }
          }
        });
        return turnId;

      case 11: // TURN_PAUSE
        this.logger.log('Turn paused');
        break;

      case 12: // TURN_RESUME
        this.logger.log('Turn resumed');
        break;

      case 13: // TURN_END
        const existingTurnId = this.findTurnIdByClient(client);
        const file = this.tempFiles.get(existingTurnId);
        if (existingTurnId && file) {
          this.logger.log(`TURN_END: ${existingTurnId}, file: ${file}`);
          this.wsService.disconnect();
          this.speechService
            .sendSpeechResponse(existingTurnId, file, false)
            .then((result) => {
              this.deliverySubject.next(result);
              this.logger.log(`Delivery pushed for ${existingTurnId}`);
            })
            .catch((err) => this.logger.error('STT 실패:', err.message));
        }
        return existingTurnId;

      default:
        this.logger.warn(`Unknown event: ${event}`);
    }

    return this.findTurnIdByClient(client);
  }

  /**
   * 오디오 청크 처리
   */
  processAudioBuffer(data: { turnId: string; content: Buffer; ttsStatus: number }): void {
    const tempFile = this.tempFiles.get(data.turnId);
    if (tempFile) {
      this.fileService.appendToFile(tempFile, data.content);
      this.wsService.send(data.ttsStatus, data.content);
    } else {
      this.logger.warn(`No temp file found for turnId: ${data.turnId}`);
    }
  }

  /**
   * 소켓을 기준으로 turnId 찾기
   */
  private findTurnIdByClient(client: Socket): string {
    for (const [turnId, sock] of this.clientMap.entries()) {
      if (sock.id === client.id) return turnId;
    }
    return '';
  }
}