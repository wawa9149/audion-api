import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { Subject, Observable } from 'rxjs';
import { Socket, Server } from 'socket.io';
import { FileService } from './file.service';
import { SpeechService } from './speech.service';
import { WebSocketService, EpdResponse } from './websocket.service';
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
  flag: boolean;      // EPD_SPEECH가 시작된 상태인지
  recognized: boolean;// 짧은 pause 이후 이미 인식했는지
  lastChunk: number;  // 마지막으로 STT 요청한 시점
  nChunks: number;    // 현재까지 받은 audio chunk 개수
}

interface SttRequest {
  sessionId: string;
  state: StreamState;
  end: number;
}

@Injectable()
export class SohriService implements OnModuleInit {
  private readonly logger = new Logger(SohriService.name);
  private server: Server;

  // sessionId -> 소켓
  private clientMap = new Map<string, Socket>();

  // sessionId -> 녹음 버퍼
  private bufferMap = new Map<string, BufferManager>();

  // sessionId -> EPD 처리 상태
  private stateMap = new Map<string, StreamState>();
  private sttQueue: SttRequest[] = [];
  private deliverySubject = new Subject<any>();

  // 통계용
  private sttStatsMap = new Map<string, { totalTime: number; count: number }>();

  // 내부적으로 STT 요청 순서를 세기 위한 카운터
  private sttCallCounter = 0;

  constructor(
    private readonly fileService: FileService,
    private readonly speechService: SpeechService,
    private readonly wsService: WebSocketService,
  ) {
    // EPD WebSocket은 한 번만 연결
    this.wsService.connect();

    // EPD 응답은 콜백으로 비동기 처리
    this.wsService.setEpdCallback(this.handleEpdMessage.bind(this));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // WebSocket Gateway에서 호출
  // ───────────────────────────────────────────────────────────────────────────


  onModuleInit() {
    setInterval(() => this.processBatchSTT(), 100);
  }

  setServer(server: Server) {
    this.server = server;
  }

  getClientByTurnId(sessionId: string): Socket | undefined {
    return this.clientMap.get(sessionId);
  }

  getDeliveryStream(): Observable<any> {
    return this.deliverySubject.asObservable();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 클라이언트로부터 'eventRequest' 메시지를 수신할 때 호출됨
  // ───────────────────────────────────────────────────────────────────────────
  async handleEvent(data: { event: number; sessionId?: string }, client: Socket): Promise<string> {
    const { event, sessionId } = data;

    switch (event) {
      // TURN_START
      case 10: {
        const newId = uuidv4();
        this.clientMap.set(newId, client);
        this.stateMap.set(newId, {
          start: 0,
          end: 0,
          flag: false,
          recognized: false,
          lastChunk: 0,
          nChunks: 0,
        });
        this.bufferMap.set(newId, new BufferManager());
        client.emit('turnReady', { sessionId: newId });
        this.logger.log(`TURN_START: ${newId}`);
        return newId;
      }
      // TURN_END
      case 13: {
        const id = sessionId || this.findTurnIdByClient(client);
        if (!id) return '';
        this.logger.log(`TURN_END 요청: ${id}`);
        const stats = this.sttStatsMap.get(id);
        if (stats && stats.count > 0) {
          const avg = (stats.totalTime / stats.count).toFixed(2);
          this.logger.log(`[${id}] 🏁 평균처리: ${avg} ms / ${stats.count} 회`);
          this.sttStatsMap.delete(id);
        }
        const sock = this.clientMap.get(id);
        if (sock) sock.emit('deliveryEnd', { sessionId: id });
        this.cleanupTurn(id);
        return id;
      }
      default:
        return this.findTurnIdByClient(client) || '';
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 클라이언트로부터 오디오 청크가 전송될 때 처리
  // ───────────────────────────────────────────────────────────────────────────
  async processAudioBuffer(data: { sessionId: string; content: Buffer }): Promise<void> {
    const { sessionId, content } = data;
    if (!this.bufferMap.has(sessionId)) return;
    const buffer = this.bufferMap.get(sessionId);
    buffer?.append(content);
    const state = this.stateMap.get(sessionId);
    if (!state) return;
    state.nChunks++;
    const rawUuid = Buffer.from(sessionId.replace(/-/g, ''), 'hex');
    if (rawUuid.length !== 16) return;
    const combined = Buffer.concat([rawUuid, content]);
    this.wsService.sendMessage(sessionId, combined);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // EPD WebSocket 메시지 수신 처리
  // ───────────────────────────────────────────────────────────────────────────
  private async handleEpdMessage(epdRes: EpdResponse) {
    const { session_id, status } = epdRes;
    const state = this.stateMap.get(session_id);
    if (!state) return;

    if (status === AudioStreamResponseStatus.EPD_SPEECH) {
      if (!state.flag) {
        state.flag = true;
        state.start = state.nChunks >= 3 ? state.nChunks - 3 : 0;
        state.lastChunk = state.nChunks;
      } else {
        if (state.nChunks - state.lastChunk >= 5) {
          state.end = state.nChunks;
          if (state.end - state.start > 1) {
            state.lastChunk = state.nChunks;
            this.enqueueStt(session_id, { ...state }, 0);
          }
        }
      }
      state.recognized = false;
    }

    if (status === AudioStreamResponseStatus.EPD_PAUSE && !state.recognized) {
      if (state.nChunks - state.start > 50) {
        // 긴 pause
        state.end = state.nChunks;
        if (state.end - state.start > 1) {
          this.logger.debug(`PAUSE: ${state.start} ~ ${state.end}`);
          this.enqueueStt(session_id, { ...state }, 1);
          this.resetState(session_id, state);
        }
      } else {
        // 짧은 pause
        state.end = state.nChunks;
        state.lastChunk = state.nChunks;
        if (state.end - state.start > 1) {
          this.logger.log(`PAUSE: ${state.start} ~ ${state.end}`);
          this.enqueueStt(session_id, { ...state }, 0);
          state.recognized = true;
        }
      }
      return;
    }

    if (status === AudioStreamResponseStatus.EPD_END && state.flag) {
      state.end = state.nChunks;
      if (state.end - state.start > 1) {
        this.enqueueStt(session_id, { ...state }, 1);
        this.resetState(session_id, state);
      }
      return;
    }
  }

  private enqueueStt(sessionId: string, state: StreamState, end: number) {
    this.sttQueue.push({ sessionId, state, end });
  }

  private async processBatchSTT() {
    if (this.sttQueue.length === 0) return;
    const batch = this.sttQueue.splice(0, 16);
    const sttInputList = batch.map(({ sessionId, state }) => {
      const buffer = this.bufferMap.get(sessionId);
      if (!buffer) return null;
      const sliced = buffer.readRange(state.start, state.end);
      return {
        sessionId,
        start: state.start,
        end: state.end,
        pcmBuffer: sliced,
      };
    }).filter((v): v is NonNullable<typeof v> => !!v);

    try {
      this.logger.log(`🔊 STT 요청: ${sttInputList.length} 개`);
      const results = await this.speechService.sendBatchSpeechResponse(sttInputList);
      results.forEach(({ sessionId, result }) => {
        const req = batch.find(r => r.sessionId === sessionId);
        if (!req) return;
        const label = `[#BATCH-${this.sttCallCounter++}] [${sessionId}] ${req.state.start}~${req.state.end}`;
        this.deliverySubject.next({ ...result, end: req.end });
        this.logger.log(`${label} ✅ STT 응답 완료`);
        const stats = this.sttStatsMap.get(sessionId) || { totalTime: 0, count: 0 };
        stats.totalTime += result.elapsed || 0;
        stats.count++;
        this.sttStatsMap.set(sessionId, stats);
      });
    } catch (err: any) {
      this.logger.error(`🔴 STT 일괄 처리 실패: ${err.message}`);
    }
  }

  private cleanupTurn(sessionId: string) {
    this.clientMap.delete(sessionId);
    this.bufferMap.delete(sessionId);
    this.stateMap.delete(sessionId);
    this.sttStatsMap.delete(sessionId);
  }

  private resetState(sessionId: string, prev: StreamState) {
    this.stateMap.set(sessionId, {
      start: prev.end,
      end: prev.end,
      flag: false,
      recognized: false,
      lastChunk: prev.nChunks,
      nChunks: prev.nChunks,
    });
  }

  private findTurnIdByClient(client: Socket): string {
    for (const [key, sock] of this.clientMap.entries()) {
      if (sock.id === client.id) return key;
    }
    return '';
  }
}