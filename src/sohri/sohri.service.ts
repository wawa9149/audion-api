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

interface StreamState {
  start: number;
  end: number;
  flag: boolean;
  recognized: boolean;
  lastChunk: number;
  nChunks: number;
}

@Injectable()
export class SohriService {
  private readonly logger = new Logger(SohriService.name);
  private clientMap = new Map<string, Socket>();
  private tempFiles = new Map<string, string>();
  private deliverySubject = new Subject<any>();
  private server: Server;

  private stateMap = new Map<string, StreamState>();

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

  handleEvent(data: { event: number; turnId?: string }, client: Socket): string {
    const { event, turnId } = data;

    switch (event) {
      case 10: {
        const newTurnId = uuidv4();
        const tempFile = this.fileService.prepareTempFile(newTurnId);
        this.tempFiles.set(newTurnId, tempFile);
        this.clientMap.set(newTurnId, client);
        this.stateMap.set(newTurnId, {
          start: 0,
          end: 0,
          flag: false,
          recognized: false,
          lastChunk: 0,
          nChunks: 0,
        });
        this.logger.log(`TURN_START: ${newTurnId}`);
        this.wsService.connect();
        return newTurnId;
      }
      case 13: {
        const id = turnId || this.findTurnIdByClient(client);
        const file = this.tempFiles.get(id);
        if (id && file) {
          this.logger.log(`TURN_END: ${id}, file: ${file}`);

          // 👇 상태 강제 정리 (중요!)
          this.clientMap.delete(id);
          this.tempFiles.delete(id);
          this.stateMap.delete(id); // 💥 여기가 핵심

          this.speechService.sendSpeechResponse(id, file)
            .then((result) => {
              if (result) {
                this.logger.log(`Final STT result for ${id} saved.`);
              }
            })
            .catch((err) => this.logger.error('STT 실패:', err.message));
        }
        return id;
      }
      default:
        return this.findTurnIdByClient(client);
    }
  }

  async processAudioBuffer(data: { turnId: string; content: Buffer }): Promise<void> {
    const { turnId, content } = data;
    const tempFile = this.tempFiles.get(turnId);
    if (!tempFile) return;

    this.fileService.appendToFile(tempFile, content);

    const state = this.stateMap.get(turnId);
    if (!state) return;

    state.nChunks += 1;

    const result = await this.wsService.handleMessage(content);
    const status = result.status;
    const score = result.speech_score;

    this.logger.debug(`[${turnId}] EPD: ${status}, score: ${score}`);

    if (status === AudioStreamResponseStatus.EPD_SPEECH) {
      if (!state.flag) {
        state.flag = true;
        state.start = state.nChunks >= 2 ? state.nChunks - 2 : 0;
        state.lastChunk = state.nChunks;
      }
      else {
        if (state.nChunks - state.lastChunk >= 5) {
          state.end = state.nChunks;
          if (state.end - state.start > 1) {
            this.logger.debug(`SPEECH: ${state.start} to ${state.end}`);
            await this.runPartialSTT(turnId, tempFile, state);
            state.lastChunk = state.nChunks;
          }
        }
      }
      state.recognized = false;
    }

    if (status === AudioStreamResponseStatus.EPD_PAUSE && !state.recognized) {
      // if (state.nChunks - state.start > 50) {
      //   state.end = state.nChunks;
      //   if (state.end - state.start > 1) {
      //     this.logger.debug(`PAUSE: ${state.start} to ${state.end}`);
      //     await this.runPartialSTT(turnId, tempFile, state, true);
      //     this.stateMap.set(turnId, {
      //       start: state.end,
      //       end: state.end,
      //       flag: false,
      //       recognized: false,
      //       lastChunk: state.nChunks,
      //       nChunks: state.nChunks,
      //     });
      //     // state.recognized = true;
      //   }
      // }

      if (!state.recognized) {
        state.end = state.nChunks;
        state.lastChunk = state.nChunks;
        if (state.end - state.start > 1) {
          this.logger.debug(`PAUSE: ${state.start} to ${state.end}`);
          await this.runPartialSTT(turnId, tempFile, state, false);
          state.recognized = true;
        }
      }

      else {
        state.lastChunk = state.nChunks;
      }
    }

    if (status === AudioStreamResponseStatus.EPD_END && state.flag) {
      state.end = state.nChunks;
      if (state.end - state.start > 1) {
        this.logger.debug(`END: ${state.start} to ${state.end}`);
        await this.runPartialSTT(turnId, tempFile, state, true);
        this.stateMap.set(turnId, {
          start: state.end,
          end: state.end,
          flag: false,
          recognized: false,
          lastChunk: state.nChunks,
          nChunks: state.nChunks,
        });
      }
    }
  }

  private async runPartialSTT(turnId: string, file: string, state: StreamState, isPartial = false): Promise<void> {
    try {
      const result = await this.speechService.sendSpeechResponse(
        turnId,
        file,
        state.start,
        state.end,
      );
      if (result) {
        this.deliverySubject.next({ ...result, isPartial });
        // state.recognized = true;
        // state.start = state.end; // 다음 청크를 위해 시작점 업데이트
        this.logger.log(`Partial STT result for ${turnId}`);
      }
    } catch (err) {
      this.logger.error(`Partial STT 실패: ${err.message}`);
    }
  }

  private findTurnIdByClient(client: Socket): string {
    for (const [turnId, sock] of this.clientMap.entries()) {
      if (sock.id === client.id) return turnId;
    }
    return '';
  }
}
