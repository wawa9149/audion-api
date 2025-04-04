import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { Subject, Observable } from 'rxjs';
import { Socket, Server } from 'socket.io';
import { FileService } from './file.service';
import { SpeechService } from './speech.service';
import { WebSocketService } from './websocket.service';
import { BufferManager } from 'src/utils/buffer-manager';

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
  private deliverySubject = new Subject<any>();
  private server: Server;
  private sttQueueMap = new Map<string, Promise<void>>();
  private bufferMap = new Map<string, BufferManager>();

  private stateMap = new Map<string, StreamState>();
  private sttCallCounter = 0;

  constructor(
    private readonly fileService: FileService,
    private readonly speechService: SpeechService,
    private readonly wsService: WebSocketService,
  ) { }

  private resetState(turnId: string, prev: StreamState) {
    this.stateMap.set(turnId, {
      start: prev.end,               // ✅ 다음 구간은 이전 end부터 시작
      end: prev.end,
      flag: false,
      recognized: false,
      lastChunk: prev.nChunks,      // 마지막 STT가 호출된 시점 기준
      nChunks: prev.nChunks,        // 전체 누적된 청크 수 유지
    });
  }


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
        this.clientMap.set(newTurnId, client);
        this.stateMap.set(newTurnId, {
          start: 0,
          end: 0,
          flag: false,
          recognized: false,
          lastChunk: 0,
          nChunks: 0,
        });
        this.bufferMap.set(newTurnId, new BufferManager());
        client.emit('turnReady', { turnId: newTurnId });

        this.logger.log(`TURN_START: ${newTurnId}`);
        this.wsService.connect();
        return newTurnId;
      }
      case 13: {
        const id = turnId || this.findTurnIdByClient(client);
        const buffer = this.bufferMap.get(id);

        // stt queue 초기화
        const sttQueue = this.sttQueueMap.get(id);
        if (sttQueue) {
          this.logger.log(`TURN_END: ${id}, sttQueue 초기화`);
          this.sttQueueMap.delete(id);
        }

        // buffer 초기화
        if (id && buffer) {
          this.logger.log(`TURN_END: ${id}, buffer: ${buffer}`);

          // 👇 상태 강제 정리 (중요!)
          this.clientMap.delete(id);
          this.stateMap.delete(id); // 💥 여기가 핵심
          this.bufferMap.delete(id);
        }
        return id;
      }
      default:
        return this.findTurnIdByClient(client);
    }
  }

  async processAudioBuffer(data: { turnId: string; content: Buffer }): Promise<void> {
    const { turnId, content } = data;

    // 👇 TURN_START가 완료되지 않은 경우 대기
    if (!this.bufferMap.has(turnId)) {
      this.logger.warn(`[${turnId}] 아직 BufferManager 초기화 전, 청크 무시`);
      return;
    }

    const buffer = this.bufferMap.get(turnId);
    if (!buffer) {
      this.logger.warn(`[${turnId}] ❌ BufferManager 없음`);
      return;
    }

    buffer.append(content);  // ✅ 메모리 버퍼에 청크 추가


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
            this.logger.log(`SPEECH: ${state.start} to ${state.end}`);
            await this.runPartialSTTQueue(turnId, state, 0);
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
      //     await this.runPartialSTTQueue(turnId, state, 0);
      //     this.resetState(turnId, state);
      //     // state.recognized = true;
      //   }
      // }

      if (!state.recognized) {
        state.end = state.nChunks;
        state.lastChunk = state.nChunks;
        if (state.end - state.start > 1) {
          this.logger.log(`PAUSE: ${state.start} to ${state.end}`);
          await this.runPartialSTTQueue(turnId, state, 0);
          state.recognized = true;
        }
      }

      else {
        state.lastChunk = state.nChunks;
      }
    }

    if (status === AudioStreamResponseStatus.EPD_END && state.flag) {
      state.end = state.nChunks;
      this.logger.log(`END1: ${state.start} to ${state.end}`);
      if (state.end - state.start > 1) {
        this.logger.log(`END2: ${state.start} to ${state.end}`);
        await this.runPartialSTTQueue(turnId, state, 1);

        this.resetState(turnId, state);
      }
    }
  }

  private async runPartialSTTQueue(
    turnId: string,
    state: StreamState,
    end: number
  ): Promise<void> {
    const prev = this.sttQueueMap.get(turnId) || Promise.resolve();
    const queueOrder = this.sttCallCounter++; // 순차 번호 부여
    const label = `[#${queueOrder}] [${turnId}] ${state.start}~${state.end}`;

    const task = prev
      .then(async () => {
        this.logger.log(`${label} ▶️ Dequeued & 시작`);
        await this.runPartialSTT(turnId, { ...state }, end, queueOrder);
      })
      .catch(err => {
        this.logger.error(`${label} ❌ 큐 처리 중 오류: ${err.message}`);
      });

    this.logger.log(`${label} ⏳ Enqueued`);
    this.sttQueueMap.set(turnId, task);
  }


  private async runPartialSTT(
    turnId: string,
    state: StreamState,
    end: number,
    order?: number
  ): Promise<void> {

    if (end === 1) {
      const dummy = {};
      this.deliverySubject.next({ ...dummy, end });
      this.logger.log(`[${turnId}] 🔄 더미 응답 전송`);
    }

    const label = order !== undefined
      ? `[#${order}] [${turnId}] ${state.start}~${state.end}`
      : `[${turnId}] ${state.start}~${state.end}`;

    this.logger.log(`${label} 🟢 STT 요청 시작`);

    try {

      const buffer = this.bufferMap.get(turnId);
      if (!buffer) {
        this.logger.warn(`${label} ⚠️ BufferManager not found`);
        return;
      }

      const sliced = buffer.readRange(state.start, state.end);

      const result = await this.speechService.sendSpeechResponse(
        turnId,
        sliced,
        state.start,
        state.end
      );
      if (result) {
        this.deliverySubject.next({ ...result, end });
        this.logger.log(`${label} ✅ STT 응답 완료`);
      }
    } catch (err) {
      this.logger.error(`${label} 🔴 STT 실패: ${err.message}`);
    }
  }

  private findTurnIdByClient(client: Socket): string {
    for (const [turnId, sock] of this.clientMap.entries()) {
      if (sock.id === client.id) return turnId;
    }
    return '';
  }
}
