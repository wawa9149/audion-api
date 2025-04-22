import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { Subject, Observable } from 'rxjs';
import { Socket, Server } from 'socket.io';
import { WebSocketService, EpdResponse } from './websocket.service';
import { BufferManager } from 'src/utils/buffer-manager';
import { SpeechService } from './speech.service';
import { FileService } from './file.service';

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

interface SttRequest {
  sequence: number;
  sessionId: string;
  state: StreamState;
  end: number;
}

@Injectable()
export class SohriService implements OnModuleInit {
  private readonly logger = new Logger(SohriService.name);
  private server: Server;
  private clientMap = new Map<string, Socket>();
  private bufferMap = new Map<string, BufferManager>();
  private stateMap = new Map<string, StreamState>();
  private sttQueue: SttRequest[] = [];
  private sttStatsMap = new Map<string, { totalTime: number; count: number }>();

  // ▶ seq 발급기, 클라이언트별 기대 seq, 보류중인 결과, skip 타이머
  /** per‐session sequence 관리맵 */
  private sessionSeq = new Map<string, number>();
  private expectedSeq = new Map<string, number>();
  private pendingResults = new Map<string, Map<number, { result: any; end: number }>>();
  private skipTimers = new Map<string, NodeJS.Timeout>();

  private deliverySubject = new Subject<any>();

  constructor(
    private readonly fileService: FileService,
    private readonly speechService: SpeechService,
    private readonly wsService: WebSocketService,
  ) {
    this.wsService.connect();
    this.wsService.setEpdCallback(this.handleEpdMessage.bind(this));
  }

  onModuleInit() {
    setInterval(() => this.processBatchSTT(), 500);
  }

  setServer(server: Server) { this.server = server; }
  getClientByTurnId(id: string) { return this.clientMap.get(id); }
  getDeliveryStream(): Observable<any> { return this.deliverySubject.asObservable(); }

  // ── TURN_START / TURN_END 처리 ─────────────────────────────────────────────
  async handleEvent(
    data: { event: number; sessionId?: string },
    client: Socket,
  ): Promise<string> {
    const { event, sessionId } = data;
    switch (event) {
      case 10: { // TURN_START
        const newId = uuidv4();
        this.clientMap.set(newId, client);
        this.stateMap.set(newId, { start: 0, end: 0, flag: false, recognized: false, lastChunk: 0, nChunks: 0 });
        this.bufferMap.set(newId, new BufferManager());

        // ★ 세션별 sequence 초기화
        this.sessionSeq.set(newId, 0);
        this.expectedSeq.set(newId, 0);
        this.pendingResults.set(newId, new Map());

        client.emit('turnReady', { sessionId: newId });
        this.logger.log(`TURN_START: ${newId}`);
        return newId;
      }
      case 13: { // TURN_END
        const id = sessionId || this.findTurnIdByClient(client);
        if (!id) return '';
        this.logger.log(`TURN_END 요청: ${id}`);

        await this.awaitNoMoreEpd(id, 25000, 500);

        // leftover final STT
        const st = this.stateMap.get(id)!;
        const leftover = st.nChunks - st.start;
        if (leftover > 1) {
          st.end = st.nChunks;
          this.enqueueStt(id, { ...st }, 1);
        }

        await this.processSttRequestsForSession(id);


        // (2.1) pendingResults가 모두 비워질 때까지 대기
        await this.waitUntilPendingEmpty(id);

        // 통계 로그, 정리
        const stats = this.sttStatsMap.get(id);
        if (stats) {
          const avg = (stats.totalTime / stats.count).toFixed(2);
          this.logger.log(`[${id}] 🏁 평균처리: ${avg} ms / ${stats.count} 회`);
        }

        // deliveryEnd
        const sock = this.clientMap.get(id);
        if (sock) sock.emit('deliveryEnd', { sessionId: id });

        this.cleanupTurn(id);
        return id;
      }
      default:
        return this.findTurnIdByClient(client) || '';
    }
  }

  // ── EPD 대기 ────────────────────────────────────────────────────────────────
  private async awaitNoMoreEpd(id: string, maxMs: number, idleMs: number) {
    const st = this.stateMap.get(id);
    if (!st) return;
    this.logger.log(`[${id}] EPD 대기 시작 (max=${maxMs}, idle=${idleMs})`);
    let last = st.nChunks, start = Date.now();
    while (Date.now() - start < maxMs) {
      await new Promise(r => setTimeout(r, idleMs));
      if (!this.stateMap.has(id)) break;
      const cur = this.stateMap.get(id)!.nChunks;
      if (cur === last) {
        this.logger.log(`[${id}] ${idleMs}ms 동안 nChunks 변화 없음, 종료`);
        return;
      }
      last = cur;
    }
    this.logger.log(`[${id}] 최대 대기시간 도달, 종료`);
  }

  // ── Audio 스트림 처리 ─────────────────────────────────────────────────────
  async processAudioBuffer(data: { sessionId: string; content: Buffer }) {
    const { sessionId, content } = data;
    if (!this.bufferMap.has(sessionId)) return;
    this.bufferMap.get(sessionId)!.append(content);
    // EPD 전송
    const raw = Buffer.from(sessionId.replace(/-/g, ''), 'hex');
    if (raw.length !== 16) return;
    this.wsService.sendMessage(sessionId, Buffer.concat([raw, content]));
  }

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

    // 그 외 상태는 무시 (EPD_WAITING, EPD_TIMEOUT 등)
  }

  /** STT 요청 큐에 등록 */
  private enqueueStt(sessionId: string, state: StreamState, end: number) {
    // ★ 세션별로 꺼내고 증가
    const seq = this.sessionSeq.get(sessionId)!;
    this.sessionSeq.set(sessionId, seq + 1);

    this.sttQueue.push({ sequence: seq, sessionId, state, end });
  }

  /** pendingResults[id]가 empty해질 때까지 폴링 */
  private async waitUntilPendingEmpty(sessionId: string) {
    while (true) {
      const pending = this.pendingResults.get(sessionId);
      if (!pending || pending.size === 0) break;
      await new Promise(res => setTimeout(res, 100));
    }
  }


  private async processBatchSTT() {
    if (this.sttQueue.length === 0) return;

    // 1) batch 뽑아서 순서대로 정렬
    const batch = this.sttQueue.splice(0, 16)
      .sort((a, b) => a.sequence - b.sequence);

    // 2) utteranceId → req 매핑 테이블
    const reqMap = new Map<string, SttRequest>();
    for (const req of batch) {
      const utteranceId = `${req.sessionId}_${req.state.start}-${req.state.end}`;
      reqMap.set(utteranceId, req);
    }

    // 3) PCM 잘라내기
    const inputs = batch.map(req => ({
      sessionId: req.sessionId,
      start: req.state.start,
      end: req.state.end,
      pcmBuffer: this.bufferMap.get(req.sessionId)!.readRange(req.state.start, req.state.end),
      sequence: req.sequence,
      isFinal: req.end === 1,
    }));

    const ts = Date.now();
    this.logger.log(`🔊 STT 요청: ${inputs.length}개 (batch)`);

    // 4) 보내고 응답 받기
    const results = await this.speechService.sendBatchSpeechResponse(inputs);
    const elapsed = Date.now() - ts;

    // 5) 응답 하나하나 처리
    for (const { sessionId, result } of results) {
      const utteranceId = result.speech.id;             // e.g. "4b20…_228-246"
      const req = reqMap.get(utteranceId);
      if (!req) {
        this.logger.warn(`매칭되는 STT 요청을 찾을 수 없습니다: ${utteranceId}`);
        continue;
      }
      this.bufferAndTryDeliver(
        sessionId,
        req.sequence,
        result,
        req.end,
        elapsed
      );
    }

    // 6) 개수 불일치 쉽게 파악용 로그
    if (results.length !== batch.length) {
      this.logger.warn(
        `요청(${batch.length}) vs 응답(${results.length}) 개수 불일치`
      );
    }
  }


  private bufferAndTryDeliver(
    sessionId: string,
    seq: number,
    result: any,
    end: number,
    elapsed: number
  ) {
    // 1) 보류 맵에 넣기
    const pending = this.pendingResults.get(sessionId)!;
    pending.set(seq, { result, end });

    // // 2) 타임아웃 예약 (누락 seq 건너뛰기)
    // if (!this.skipTimers.has(sessionId)) {
    //   this.skipTimers.set(sessionId,
    //     setTimeout(() => {
    //       const exp = this.expectedSeq.get(sessionId)!;
    //       this.expectedSeq.set(sessionId, exp + 1);
    //       this.skipTimers.delete(sessionId);
    //       this.tryDeliver(sessionId, elapsed);
    //     }, 5000)
    //   );
    // }

    // 3) 시도
    this.tryDeliver(sessionId, elapsed);
  }

  private tryDeliver(sessionId: string, elapsed: number) {
    const sock = this.clientMap.get(sessionId);
    if (!sock) return;

    const pending = this.pendingResults.get(sessionId)!;
    let expected = this.expectedSeq.get(sessionId)!;

    while (pending.has(expected)) {
      const { result, end } = pending.get(expected)!;
      pending.delete(expected);
      this.deliverySubject.next({ sessionId: sessionId, result, end: end });
      this.logger.log(`[DELIVER] seq=${expected} session=${sessionId} (${elapsed}ms)`);
      expected++;
      this.expectedSeq.set(sessionId, expected);
    }

    // 만약 더 이상 deliver 할 게 없으면 타임아웃 클리어
    if (pending.size === 0 && this.skipTimers.has(sessionId)) {
      clearTimeout(this.skipTimers.get(sessionId)!);
      this.skipTimers.delete(sessionId);
    }
  }

  /**
 * TURN_END 시점에 남아있는 해당 sessionId 의 STT 요청들을
 * sequence 순으로 batch로 묶어서 보내고, 나오는 결과도 순차 delivery.
 */
  private async processSttRequestsForSession(sessionId: string): Promise<void> {
    // 계속 반복해서, 해당 sessionId 요청만 골라서 flush
    while (true) {
      // 1) sessionId 에 해당하는 요청만 뽑아서
      const batch = this.sttQueue
        .filter(r => r.sessionId === sessionId)
        .sort((a, b) => a.sequence - b.sequence)
        .splice(0, 16);

      // 2) 큐에서 제거
      this.sttQueue = this.sttQueue.filter(r =>
        r.sessionId !== sessionId || !batch.includes(r)
      );

      if (batch.length === 0) break;

      // 3) PCM 잘라내고 STT 요청
      const inputs = batch.map(req => ({
        sessionId: req.sessionId,
        start: req.state.start,
        end: req.state.end,
        pcmBuffer: this.bufferMap
          .get(req.sessionId)!
          .readRange(req.state.start, req.state.end),
        sequence: req.sequence,
        isFinal: req.end === 1,
      }));

      const ts = Date.now();
      this.logger.log(`(flush) 🔊 STT 요청: ${inputs.length}개 (session=${sessionId})`);
      const results = await this.speechService.sendBatchSpeechResponse(inputs);
      const elapsed = Date.now() - ts;

      // 4) 결과를 순서 보장하며 buffer→deliver
      for (let i = 0; i < results.length; i++) {
        const { sessionId: sid, result } = results[i];
        const req = batch[i];
        this.bufferAndTryDeliver(sid, req.sequence, result, req.end, elapsed);
      }
    }
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

  /** TURN 정리 시 */
  private cleanupTurn(sessionId: string) {
    this.logger.log(`TURN 정리: ${sessionId}`);

    this.clientMap.delete(sessionId);
    this.bufferMap.delete(sessionId);
    this.stateMap.delete(sessionId);
    this.sttStatsMap.delete(sessionId);
    this.expectedSeq.delete(sessionId);
    this.pendingResults.delete(sessionId);
    if (this.skipTimers.has(sessionId)) clearTimeout(this.skipTimers.get(sessionId)!);
    // ★ 세션별 sequence 삭제
    this.sessionSeq.delete(sessionId);
  }

  private findTurnIdByClient(client: Socket): string {
    for (const [sid, sock] of this.clientMap.entries()) {
      if (sock.id === client.id) return sid;
    }
    return '';
  }
}
