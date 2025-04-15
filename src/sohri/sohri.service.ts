import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { Subject, Observable } from 'rxjs';
import { Socket, Server } from 'socket.io';
import { FileService } from './file.service';
import { SpeechService } from './speech.service';
import { WebSocketService, EpdResponse } from './websocket.service'; // EpdResponse export
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

@Injectable()
export class SohriService {
  private readonly logger = new Logger(SohriService.name);

  private server: Server;

  // sessionId -> 소켓
  private clientMap = new Map<string, Socket>();

  // sessionId -> 녹음 버퍼
  private bufferMap = new Map<string, BufferManager>();

  // sessionId -> EPD 처리 상태
  private stateMap = new Map<string, StreamState>();

  // STT 요청 체인 (Promise)
  private sttQueueMap = new Map<string, Promise<void>>();

  // 인식 결과 전달용
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
  // 이벤트 처리
  // ───────────────────────────────────────────────────────────────────────────
  async handleEvent(
    data: { event: number; sessionId?: string },
    client: Socket
  ): Promise<string> {
    const { event, sessionId } = data;

    switch (event) {
      case 10: { // TURN_START
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

      case 13: { // TURN_END
        const id = sessionId || this.findTurnIdByClient(client);
        if (!id) return '';

        this.logger.log(`TURN_END 요청: ${id}`);

        // 혹시 남아 있는 STT Queue가 있다면 대기
        const sttChain = this.sttQueueMap.get(id) || Promise.resolve();
        try {
          await sttChain;
        } catch (err) {
          this.logger.error(`턴 종료 전 STT 체인 오류: ${err.message}`);
        }

        // leftover 구간 처리
        const state = this.stateMap.get(id);
        if (state) {
          const leftover = state.nChunks - state.start;
          if (leftover > 1) {
            state.end = state.nChunks;
            this.logger.log(`(turn_end) leftover final STT: ${state.start}~${state.end}`);
            try {
              // 필요시: 직접 STT 호출 (여기선 주석)
              await this.runPartialSTT(id, { ...state }, 1, 9999);
            } catch (err) {
              this.logger.error(`LEFTOVER STT 오류: ${err.message}`);
            }
          }
        }

        // 통계 출력
        const stats = this.sttStatsMap.get(id);
        if (stats && stats.count > 0) {
          const avg = (stats.totalTime / stats.count).toFixed(2);
          this.logger.log(`[${id}] 🏁 평균처리: ${avg} ms / ${stats.count} 회`);
          this.sttStatsMap.delete(id);
        }

        // 클라이언트에 deliveryEnd
        const sock = this.clientMap.get(id);
        if (sock) {
          sock.emit('deliveryEnd', { sessionId: id });
        }

        // cleanup
        this.cleanupTurn(id);
        return id;
      }

      default:
        return this.findTurnIdByClient(client) || '';
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 청크 처리
  // ───────────────────────────────────────────────────────────────────────────
  async processAudioBuffer(data: { sessionId: string; content: Buffer }): Promise<void> {
    const { sessionId, content } = data;

    if (!this.bufferMap.has(sessionId)) {
      this.logger.warn(`[${sessionId}] 아직 BufferManager 초기화 전, 청크 무시`);
      return;
    }

    const buffer = this.bufferMap.get(sessionId);
    if (!buffer) {
      this.logger.warn(`[${sessionId}] ❌ BufferManager 없음`);
      return;
    }

    // 녹음 버퍼에 쌓기
    buffer.append(content);

    // nChunks 증가
    const state = this.stateMap.get(sessionId);
    if (!state) return;
    state.nChunks++;
    this.logger.log(`[${sessionId}] nChunks: ${state.nChunks}`);

    // [16바이트 rawUuid][audio] 형태로 전송
    const rawUuid = Buffer.from(sessionId.replace(/-/g, ''), 'hex');
    if (rawUuid.length !== 16) {
      this.logger.error(`[${sessionId}] ❌ sessionId->raw 변환 실패 (${rawUuid.length} bytes)`);
      return;
    }
    const combined = Buffer.concat([rawUuid, content]);
    console.log(`[${sessionId}] combined: ${combined.length} bytes`);

    // 🎯 EPD 서버로 전송 (WebSocketService)
    this.wsService.sendMessage(sessionId, combined);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // EPD 응답 콜백 - 한 번만 등록 (WebSocketService -> SohriService)
  // ───────────────────────────────────────────────────────────────────────────
  private async handleEpdMessage(epdRes: EpdResponse) {
    const { session_id, status, speech_score } = epdRes;

    this.logger.log(`[${session_id}] EPD: ${status}, score=${speech_score}`);

    const state = this.stateMap.get(session_id);
    this.logger.log(`[${session_id}] EPD 상태: ${JSON.stringify(state)}`);
    if (!state) {
      this.logger.warn(`EPD 응답 처리할 state 없음: ${session_id}`);
      return;
    }
    //   const dummy = {};
    //   this.deliverySubject.next({ ...dummy, end: 0, });
    //   this.logger.log(`[${session_id}] 🔄 더미 응답 전송`);

    // }
    // EPD 로직: SPEECH / PAUSE / END
    if (status === AudioStreamResponseStatus.EPD_SPEECH) {
      this.logger.log(`[${session_id}] EPD_SPEECH`);
      if (!state.flag) {
        // 최초 Speech
        state.flag = true;
        state.start = (state.nChunks >= 3) ? state.nChunks - 3 : 0;
        state.lastChunk = state.nChunks;
      } else {
        // 이미 speech 중
        if (state.nChunks - state.lastChunk >= 5) {
          state.end = state.nChunks;
          if (state.end - state.start > 1) {
            this.logger.log(`SPEECH: ${state.start} ~ ${state.end}`);
            await this.runPartialSTTQueue(session_id, status, state, 0);
            state.lastChunk = state.nChunks;
          }
        }
      }
      state.recognized = false;
      return;
    }

    if (status === AudioStreamResponseStatus.EPD_PAUSE && !state.recognized) {
      if (state.nChunks - state.start > 50) {
        // 긴 pause
        state.end = state.nChunks;
        if (state.end - state.start > 1) {
          this.logger.debug(`PAUSE: ${state.start} ~ ${state.end}`);
          await this.runPartialSTTQueue(session_id, status, state, 1);
          this.resetState(session_id, state);
        }
      } else {
        // 짧은 pause
        state.end = state.nChunks;
        state.lastChunk = state.nChunks;
        if (state.end - state.start > 1) {
          this.logger.log(`PAUSE: ${state.start} ~ ${state.end}`);
          await this.runPartialSTTQueue(session_id, status, state, 0);
          state.recognized = true;
        }
      }
      return;
    }

    if (status === AudioStreamResponseStatus.EPD_END && state.flag) {
      state.end = state.nChunks;
      if (state.end - state.start > 1) {
        this.logger.log(`END: ${state.start} ~ ${state.end}`);
        await this.runPartialSTTQueue(session_id, status, state, 1);
        this.resetState(session_id, state);
      }
      return;
    }

    // 그 외 status는 무시
  }

  // ───────────────────────────────────────────────────────────────────────────
  // STT 처리 큐
  // ───────────────────────────────────────────────────────────────────────────
  private async runPartialSTTQueue(
    sessionId: string,
    epdStatus: number,
    state: StreamState,
    end: number
  ): Promise<void> {
    const prevChain = this.sttQueueMap.get(sessionId) || Promise.resolve();
    const queueOrder = this.sttCallCounter++;
    const label = `[#${queueOrder}-EPD${epdStatus}] [${sessionId}] ${state.start}~${state.end}`;

    const clonedState = { ...state };

    const task = prevChain
      .then(async () => {
        this.logger.log(`${label} ▶️ Dequeued & 시작`);
        await this.runPartialSTT(sessionId, clonedState, end, queueOrder);
      })
      .catch(err => {
        this.logger.error(`${label} ❌ STT 큐 처리 오류: ${err.message}`);
      });

    this.logger.log(`${label} ⏳ Enqueued`);
    this.sttQueueMap.set(sessionId, task);
  }

  private async runPartialSTT(sessionId: string, state: StreamState, end: number, order: number) {
    const label = `[#${order}] [${sessionId}] ${state.start}~${state.end}`;
    this.logger.log(`${label} 🟢 STT 요청 시작`);

    const startTime = Date.now();
    try {
      const buffer = this.bufferMap.get(sessionId);
      if (!buffer) {
        this.logger.warn(`${label} ⚠️ Buffer 없음`);
        return;
      }

      // 오디오 잘라서 STT 요청
      const sliced = buffer.readRange(state.start, state.end);
      const result = await this.speechService.sendSpeechResponse(
        sessionId,
        sliced,
        state.start,
        state.end,
      );

      const elapsed = Date.now() - startTime;
      if (result) {
        // (1) 중간 or 최종 결과 클라이언트 전달
        this.deliverySubject.next({ ...result, end });
        this.logger.log(`${label} ✅ STT 응답 완료 (took ${elapsed} ms)`);

        // (2) 통계 누적
        const stats = this.sttStatsMap.get(sessionId) || { totalTime: 0, count: 0 };
        stats.totalTime += elapsed;
        stats.count++;
        this.sttStatsMap.set(sessionId, stats);

        if (end === 1) {
          // 버퍼에서 해당 구간 삭제
          const buffer = this.bufferMap.get(sessionId);
          if (buffer) {
            buffer.truncateUntil(state.end - 5);
            this.logger.log(`${label} 🟢 Buffer truncateUntil: ${state.end}`);
          }
        }
      }
    } catch (err) {
      this.logger.error(`${label} 🔴 STT 실패: ${err.message}`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 기타
  // ───────────────────────────────────────────────────────────────────────────
  private cleanupTurn(sessionId: string) {
    this.logger.log(`cleanupTurn: ${sessionId}`);

    this.sttQueueMap.delete(sessionId);
    this.bufferMap.delete(sessionId);
    this.stateMap.delete(sessionId);
    this.clientMap.delete(sessionId);
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
