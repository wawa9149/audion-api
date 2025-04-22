import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { Subject, Observable } from 'rxjs';
import { Socket, Server } from 'socket.io';
import { FileService } from './file.service';
import { SpeechService } from './speech.service';
import { WebSocketService, EpdResponse } from './websocket.service';
import { BufferManager } from 'src/utils/buffer-manager';

/**
 * 외부 EPD 엔진으로부터 전달되는 상태값
 */
export enum AudioStreamResponseStatus {
  EPD_WAITING = 0,
  EPD_SPEECH = 1,
  EPD_PAUSE = 2,
  EPD_END = 3,
  EPD_TIMEOUT = 4,
  EPD_MAX_TIMEOUT = 6,
  EPD_NONE = 7,
}

/**
 * EPD 처리 상태 (turn 별로)
 */
interface StreamState {
  /** 현재 구간 시작 index (STT 가능한 위치) */
  start: number;

  /** 현재 구간 끝 index (STT 대상) */
  end: number;

  /** EPD_SPEECH가 시작된 상태인지 */
  flag: boolean;

  /** 짧은 pause 이후 이미 인식(STT) 했는지 여부 */
  recognized: boolean;

  /** 마지막으로 STT 요청한 시점 */
  lastChunk: number;

  /** 현재까지 받은 audio chunk 개수 (EPD 응답마다 +1) */
  nChunks: number;
}

/**
 * STT 요청 정보를 담는 큐 아이템
 */
interface SttRequest {
  sequence: number;      // 요청 순서 보장용
  sessionId: string;
  state: StreamState;
  end: number;           // 0=partial, 1=final
}

@Injectable()
export class SohriService implements OnModuleInit {
  private readonly logger = new Logger(SohriService.name);

  private server: Server;

  /** sessionId -> 소켓 */
  private clientMap = new Map<string, Socket>();

  /** sessionId -> 녹음 버퍼 */
  private bufferMap = new Map<string, BufferManager>();

  /** sessionId -> EPD 처리 상태 */
  private stateMap = new Map<string, StreamState>();

  /** STT 요청 정보 큐 (batch 단위 처리) */
  private sttQueue: SttRequest[] = [];

  /** STT 결과(delivery)를 전달할 Subject */
  private deliverySubject = new Subject<any>();

  /** sessionId 별 STT 처리 통계 */
  private sttStatsMap = new Map<string, { totalTime: number; count: number }>();
  private sttSeqCounter = 0;               // sequence 발급기

  /** STT 호출 순서를 기록하기 위한 카운터 */
  private sttCallCounter = 0;

  constructor(
    private readonly fileService: FileService,
    private readonly speechService: SpeechService,
    private readonly wsService: WebSocketService,
  ) {
    // EPD 웹소켓 연결
    this.wsService.connect();
    // EPD 콜백 설정
    this.wsService.setEpdCallback(this.handleEpdMessage.bind(this));
  }

  /**
   * Nest Lifecycle Hook
   * 서버 시작 후 일정 주기로 STT 큐(batch)를 처리
   */
  onModuleInit() {
    // 0.5초마다 STT 큐를 확인하여 batch 전송
    setInterval(() => this.processBatchSTT(), 500);
  }

  /**
   * SohriGateway에서 서버(소켓) 인스턴스를 주입받음
   */
  setServer(server: Server) {
    this.server = server;
  }

  /**
   * 특정 sessionId에 해당하는 소켓 반환
   */
  getClientByTurnId(sessionId: string): Socket | undefined {
    return this.clientMap.get(sessionId);
  }

  /**
   * STT 결과(delivery)를 구독할 수 있는 Observable
   */
  getDeliveryStream(): Observable<any> {
    return this.deliverySubject.asObservable();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 이벤트 처리 (TURN_START / TURN_END)
  // ──────────────────────────────────────────────────────────────────────────
  async handleEvent(
    data: { event: number; sessionId?: string },
    client: Socket,
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

        // 1) "폴링 + idle threshold" 기법으로 EPD 대기
        //    - idle 동안 nChunks 변화 없으면 종료
        //    - 최대 25초 대기
        await this.awaitNoMoreEpd(id, 25000, 500);

        // 2) leftover 구간 처리 → 최종 STT
        const st = this.stateMap.get(id);
        if (st) {
          const leftover = st.nChunks - st.start;
          if (leftover > 1) {
            // 남은 구간이 있다면 final 처리
            st.end = st.nChunks;
            this.enqueueStt(id, { ...st }, 1);
          }
        }

        // 3) 남은 STT 요청 모두 flush
        await this.processSttRequestsForSession(id);


        // 5) deliveryEnd 전송
        const sock = this.clientMap.get(id);
        if (sock) {
          sock.emit('deliveryEnd', { sessionId: id });
          this.logger.log(`DeliveryEnd 전송: ${id}`);
        }

        // 4) 통계 로그
        const stats = this.sttStatsMap.get(id);
        if (stats && stats.count > 0) {
          const avg = (stats.totalTime / stats.count).toFixed(2);
          this.logger.log(`[${id}] 🏁 평균처리: ${avg} ms / ${stats.count} 회`);
          this.sttStatsMap.delete(id);
        }

        // 6) turn cleanup
        this.cleanupTurn(id);

        return id;
      }

      default:
        // 그 외 이벤트는 sessionId만 반환
        return this.findTurnIdByClient(client) || '';
    }
  }

  /**
   * "폴링 + idle threshold" 기법으로 EPD 대기
   * @param sessionId  대기 대상 세션
   * @param maxWaitMs  최대 대기 시간(ms), 예: 25000
   * @param idleMs     idle 확인 주기(ms), 예: 300
   */
  private async awaitNoMoreEpd(
    sessionId: string,
    maxWaitMs = 25000,
    idleMs = 300
  ): Promise<void> {
    const state = this.stateMap.get(sessionId);
    if (!state) return;

    this.logger.log(`[${sessionId}] EPD 대기 시작(max=${maxWaitMs}ms, idle=${idleMs}ms)`);

    let lastN = state.nChunks;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      // idleMs 후 다시 확인
      await new Promise(res => setTimeout(res, idleMs));

      // 혹시 cleanup된 세션이면 중단
      if (!this.stateMap.has(sessionId)) break;

      const curState = this.stateMap.get(sessionId);
      if (!curState) break;

      const currentN = curState.nChunks;
      if (currentN === lastN) {
        // idleMs 동안 변화가 없었다
        this.logger.log(`[${sessionId}] idle ${idleMs}ms 동안 nChunks=${lastN} → 변화 없으므로 종료`);
        return;
      } else {
        // nChunks가 변했으니 다시 대기
        this.logger.log(`[${sessionId}] EPD 변화 감지: ${lastN} -> ${currentN}, 계속 대기`);
        lastN = currentN;
      }
    }

    this.logger.log(`[${sessionId}] 최대 대기시간(${maxWaitMs}ms) 도달, 종료`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Audio Buffer / EPD 처리
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * 클라이언트에서 audio chunk가 왔을 때
   * -> buffer에 저장 + EPD에 전송
   *    (nChunks++는 handleEpdMessage 시점에)
   */
  async processAudioBuffer(data: { sessionId: string; content: Buffer }): Promise<void> {
    const { sessionId, content } = data;
    if (!this.bufferMap.has(sessionId)) return;

    const buffer = this.bufferMap.get(sessionId);
    buffer?.append(content);

    // 여기서는 nChunks 증가하지 않음 → EPD 응답 올 때 handleEpdMessage 에서 증가

    // EPD 엔진에 전송
    const rawUuid = Buffer.from(sessionId.replace(/-/g, ''), 'hex');
    if (rawUuid.length !== 16) return;
    const combined = Buffer.concat([rawUuid, content]);
    this.wsService.sendMessage(sessionId, combined);
  }

  /**
   * EPD 엔진(WebSocket)으로부터 상태가 왔을 때
   */
  private async handleEpdMessage(epdRes: EpdResponse) {
    const { session_id, status } = epdRes;
    const state = this.stateMap.get(session_id);
    if (!state) return;

    // 이 시점에 nChunks++
    state.nChunks++;
    this.logger.log(`[EPD] sessionId=${session_id}, nChunks=${state.nChunks}, status=${status}`);

    if (status === AudioStreamResponseStatus.EPD_SPEECH) {
      if (!state.flag) {
        // 최초 speech
        state.flag = true;
        state.start = (state.nChunks >= 4) ? state.nChunks - 4 : 0;
        state.lastChunk = state.nChunks;
      } else {
        // speech 중 추가 청크
        if (state.nChunks - state.lastChunk >= 5) {
          state.end = state.nChunks;
          if (state.end - state.start > 1) {
            state.lastChunk = state.nChunks;
            this.enqueueStt(session_id, { ...state }, 0);
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
          this.logger.debug(`PAUSE(long): ${state.start} ~ ${state.end}`);
          this.enqueueStt(session_id, { ...state }, 1);
          this.resetState(session_id, state);
        }
      } else {
        // 짧은 pause
        state.end = state.nChunks;
        state.lastChunk = state.nChunks;
        if (state.end - state.start > 1) {
          this.logger.log(`PAUSE(short): ${state.start} ~ ${state.end}`);
          this.enqueueStt(session_id, { ...state }, 0);
          state.recognized = true;
        }
      }
      return;
    }

    if (status === AudioStreamResponseStatus.EPD_END && state.flag) {
      // 완결
      state.end = state.nChunks;
      if (state.end - state.start > 1) {
        this.enqueueStt(session_id, { ...state }, 1);
        this.resetState(session_id, state);
      }
      return;
    }

    // 그 외 상태는 무시
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STT 요청 (batch)
  // ──────────────────────────────────────────────────────────────────────────

  /** STT 요청 큐에 등록 */
  private enqueueStt(sessionId: string, state: StreamState, end: number) {
    this.sttQueue.push({
      sequence: this.sttSeqCounter++,
      sessionId,
      state,
      end
    });
  }
  private async processBatchSTT() {
    if (this.sttQueue.length === 0) return;

    // (1) 요청 꺼내기
    const batch = this.sttQueue.splice(0, 16);
    // 오름차순 정렬
    batch.sort((a, b) => a.sequence - b.sequence);

    // (2) PCM 잘라내기
    const inputs = batch.map(req => ({
      sessionId: req.sessionId,
      start: req.state.start,
      end: req.state.end,
      pcmBuffer: this.bufferMap.get(req.sessionId)!.readRange(req.state.start, req.state.end),
      sequence: req.sequence,
      isFinal: req.end === 1,
    }));

    const startTs = Date.now();
    this.logger.log(`🔊 STT 요청: ${inputs.length}개 (batch)`);

    let results = await this.speechService.sendBatchSpeechResponse(inputs);
    const elapsed = Date.now() - startTs;

    // (3) 응답 순서 보장
    // speechService 가 결과를 같은 순서로 돌려준다고 가정하면
    // batch 배열 순서와 1:1 매핑됨
    for (let i = 0; i < results.length; i++) {
      const { sessionId, result } = results[i];
      const req = batch[i];
      const label = `[#BATCH-${req.sequence}] [${sessionId}] ${req.state.start}~${req.state.end}`;
      this.deliverySubject.next({ sessionId, result, end: req.end });
      this.logger.log(`${label} STT 응답 완료 (${elapsed}ms)`);

      // 통계
      const stats = this.sttStatsMap.get(sessionId) ?? { totalTime: 0, count: 0 };
      stats.totalTime += elapsed;
      stats.count++;
      this.sttStatsMap.set(sessionId, stats);
    }
  }

  /**
   * short pause 등으로 구간이 끝난 뒤,
   * STT를 위한 초기화
   */
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

  // ──────────────────────────────────────────────────────────────────────────
  // TURN cleanup
  // ──────────────────────────────────────────────────────────────────────────

  /** TURN 자원 정리 */
  private cleanupTurn(sessionId: string) {
    this.clientMap.delete(sessionId);
    this.bufferMap.delete(sessionId);
    this.stateMap.delete(sessionId);
    this.sttStatsMap.delete(sessionId);
  }

  /** 소켓 -> sessionId 역추적 */
  private findTurnIdByClient(client: Socket): string {
    for (const [sid, sock] of this.clientMap.entries()) {
      if (sock.id === client.id) return sid;
    }
    return '';
  }

  /**
   * TURN_END 시점에 leftover 등 큐가 남았을 수 있으므로
   * 모두 flush 처리
   */

  // ─── TURN_END 시 남은 세션만 Flush ─────────────────────────────────────────

  private async processSttRequestsForSession(sessionId: string) {
    // 한 번에 한 덩어리씩 뽑아서 처리
    while (true) {
      // 해당 세션만 filter → remove
      const batch = this.sttQueue
        .filter(r => r.sessionId === sessionId)
        .sort((a, b) => a.sequence - b.sequence)
        .splice(0, 16);

      // 큐에서 제거
      this.sttQueue = this.sttQueue.filter(r => r.sessionId !== sessionId || !batch.includes(r));
      if (batch.length === 0) break;

      // 위 processBatchSTT 와 순서 동일하게 처리
      const inputs = batch.map(req => ({
        sessionId: req.sessionId,
        start: req.state.start,
        end: req.state.end,
        pcmBuffer: this.bufferMap.get(req.sessionId)!.readRange(req.state.start, req.state.end),
        sequence: req.sequence,
        isFinal: req.end === 1,
      }));

      const startTs = Date.now();
      this.logger.log(`(flush) 🔊 STT 요청: ${inputs.length}개 (session=${sessionId})`);
      const results = await this.speechService.sendBatchSpeechResponse(inputs);
      const elapsed = Date.now() - startTs;

      for (let i = 0; i < results.length; i++) {
        const { sessionId: sid, result } = results[i];
        const req = batch[i];
        const label = `[#FLUSH-${req.sequence}] [${sid}] ${req.state.start}~${req.state.end}`;
        this.deliverySubject.next({ sessionId: sid, result, end: req.end });
        this.logger.log(`${label} STT 응답 완료 (${elapsed}ms)`);

        const stats = this.sttStatsMap.get(sid) ?? { totalTime: 0, count: 0 };
        stats.totalTime += elapsed;
        stats.count++;
        this.sttStatsMap.set(sid, stats);
      }
    }
  }
}