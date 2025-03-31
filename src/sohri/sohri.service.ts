// src/sohri/sohri.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { Subject, Observable } from 'rxjs';
import { Socket, Server } from 'socket.io';
import { FileService } from './file.service';
import { SpeechService } from './speech.service';
import { WebSocketService } from './websocket.service';

export enum AudioStreamResponseStatus {
  EPD_WAITING = 0,
  EPD_SPEECH = 1,
  EPD_PAUSE = 2,
  EPD_END = 3,
  EPD_TIMEOUT = 4,
  EPD_MAX_TIMEOUT = 6,
  EPD_NONE = 7,
}

const CHUNK_SIZE = 1600;

@Injectable()
export class SohriService {
  private readonly logger = new Logger(SohriService.name);
  private clientMap = new Map<string, Socket>();
  private tempFiles = new Map<string, string>();
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

  handleEvent(data: { event: number }, client: Socket): string {
    const { event } = data;

    switch (event) {
      case 10: {
        const turnId = uuidv4();
        const tempFile = this.fileService.prepareTempFile(turnId);
        this.tempFiles.set(turnId, tempFile);
        this.clientMap.set(turnId, client);
        this.logger.log(`TURN_START: ${turnId}`);

        this.wsService.connect(); // ✅ WebSocket 연결

        return turnId;
      }
      case 11:
        this.logger.log('Turn paused');
        break;
      case 12:
        this.logger.log('Turn resumed');
        break;
      case 13: {
        const existingTurnId = this.findTurnIdByClient(client);
        const file = this.tempFiles.get(existingTurnId);
        if (existingTurnId && file) {
          this.logger.log(`TURN_END: ${existingTurnId}, file: ${file}`);
          this.speechService.sendSpeechResponse(existingTurnId, file, false)
            .then((result) => {
              if (result) {
                this.deliverySubject.next(result);
                this.logger.log(`Delivery pushed for ${existingTurnId}`);
              }
            })
            .catch((err) => this.logger.error('STT 실패:', err.message));
        }
        return existingTurnId;
      }
      default:
        this.logger.warn(`Unknown event: ${event}`);
    }

    return this.findTurnIdByClient(client);
  }

  async processAudioBuffer(data: { turnId: string; content: Buffer }): Promise<void> {
    const turnId = data.turnId;
    const tempFile = this.tempFiles.get(turnId);
    if (!tempFile) return;

    this.fileService.appendToFile(tempFile, data.content);

    const result = await this.wsService.handleMessage(data.content);
    const status = result.status;
    const score = result.speech_score;

    this.logger.debug(`[${turnId}] EPD: ${status}, score: ${score}`);

    if (status === AudioStreamResponseStatus.EPD_END) {
      this.speechService.sendSpeechResponse(turnId, tempFile, false)
        .then((result) => {
          if (result) this.deliverySubject.next(result);
        })
        .catch((err) => this.logger.error(`STT 실패: ${err.message}`));
    }
  }

  private findTurnIdByClient(client: Socket): string {
    for (const [turnId, sock] of this.clientMap.entries()) {
      if (sock.id === client.id) return turnId;
    }
    return '';
  }
}
