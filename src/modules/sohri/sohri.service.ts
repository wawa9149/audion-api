import { Injectable, Logger } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import * as WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import * as FormData from 'form-data';
import * as ffmpeg from 'fluent-ffmpeg';

// 시스템 ffmpeg 경로 (환경변수 FFMPEG_PATH 또는 기본값)
ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH || '/usr/bin/ffmpeg');

enum AudioStreamResponseStatus {
  PAUSE = 0,
  END = 1,
  SPEECH = 2,
  TIMEOUT = 8,
  ERROR = 9,
}

@Injectable()
export class SohriService {
  private readonly logger = new Logger(SohriService.name);
  private currentTurnId: string = '';
  private wsClient: WebSocket | null = null;
  // 임시 PCM 데이터를 저장할 파일 경로 (순수 오디오 데이터만 기록)
  private tempFile: string = '';
  // WebSocket으로 받은 상태를 전달할 Subject
  private audioResponseSubject: Subject<{ status: AudioStreamResponseStatus }> = new Subject();
  private deliverySubject: Subject<any> = new Subject();

  // TURN 이벤트 처리: TURN_START, TURN_END, TURN_PAUSE, TURN_RESUME
  handleEvent(eventRequest: { event: number }): string {
    if (eventRequest.event === 10) { // TURN_START
      this.currentTurnId = uuidv4();
      this.logger.log(`Turn started: ${this.currentTurnId}`);
      const tempDir = process.env.TEMP_DIR || '/tmp';
      // 파일 이름에 .pcm 확장자를 추가하여 순수 PCM 데이터를 저장
      this.tempFile = path.join(tempDir, uuidv4() + '.pcm');
      const dir = path.dirname(this.tempFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        this.logger.log(`Directory created: ${dir}`);
      }
      this.createWebSocketClient(this.currentTurnId);
      return this.currentTurnId;
    } else if (eventRequest.event === 13) { // TURN_END
      this.logger.log(`Turn ended: ${this.currentTurnId}`);
      this.processTurnEnd();
      return this.currentTurnId;
    } else if (eventRequest.event === 11) { // TURN_PAUSE
      this.logger.log('Turn paused');
      return this.currentTurnId;
    } else if (eventRequest.event === 12) { // TURN_RESUME
      this.logger.log('Turn resumed');
      return this.currentTurnId;
    }
    return '';
  }

  // WebSocket 클라이언트 생성 및 연결
  createWebSocketClient(turnId: string): void {
    const wsUrl = 'ws://epd.mago52.com:9707/speech2text/chunk';
    this.wsClient = new WebSocket(wsUrl);
    this.wsClient.on('open', () => {
      this.logger.log('WebSocket connected');
    });
    this.wsClient.on('message', (message: WebSocket.Data) => {
      const msg = message.toString();
      this.logger.log(`WebSocket message: ${msg}`);
      switch (msg) {
        case 'WAITING':
          break;
        case 'TIMEOUT':
          this.process(AudioStreamResponseStatus.TIMEOUT, false);
          break;
        case 'SPEECH':
          this.process(AudioStreamResponseStatus.SPEECH, false);
          break;
        case 'PAUSE':
          this.process(AudioStreamResponseStatus.PAUSE, false);
          break;
        case 'END':
          this.process(AudioStreamResponseStatus.END, false);
          break;
        case 'MAX_TIMEOUT':
          this.process(AudioStreamResponseStatus.END, true);
          break;
        default:
          this.process(AudioStreamResponseStatus.ERROR, false);
      }
    });
    this.wsClient.on('close', (code, reason) => {
      this.logger.log(`WebSocket closed: code: ${code}, reason: ${reason}`);
    });
    this.wsClient.on('error', (err) => {
      this.logger.error('WebSocket error:', err.message);
      this.process(AudioStreamResponseStatus.ERROR, false);
    });
  }

  // 동기적으로 파일에 데이터를 기록하는 메서드 (Java의 writeToFile과 동일한 역할)
  private writeToFile(data: Buffer): void {
    try {
      fs.appendFileSync(this.tempFile, data);
      this.logger.log(`Appended ${data.length} bytes to temp file`);
    } catch (err) {
      this.logger.error('Error writing to temp file:', err);
    }
  }

  // 오디오 청크 처리:
  // 1. 각 오디오 청크는 파일에 동기적으로 기록 (TTS 상태 바이트 제외)
  // 2. WebSocket 전송 시에는 TTS 상태 바이트를 붙여 전송
  async processAudioBuffer(data: { turnId: string, content: Buffer, ttsStatus: number }): Promise<void> {
    // 동기적으로 파일에 순수 오디오 데이터만 기록
    this.writeToFile(data.content);

    // WebSocket 전송용 버퍼: TTS 상태 바이트 + 오디오 데이터
    const ttsBuffer = Buffer.from([data.ttsStatus]);
    const bufferToSend = Buffer.concat([ttsBuffer, data.content]);
    this.logger.log(`Received audio chunk with TTS status: ${data.ttsStatus}`);
    this.logger.log(`Buffer size for WebSocket transmission: ${bufferToSend.length}`);

    if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
      this.wsClient.send(bufferToSend);
      this.logger.log('Sent audio chunk with TTS status via WebSocket');
    } else {
      this.logger.error('WebSocket client is not connected');
    }
  }

  // TURN_END 처리:
  // WebSocket 연결 종료 후, 이미 동기적으로 파일에 기록된 PCM 데이터를 그대로 WAV 파일로 변환하고, 음성 응답 전송 수행
  async processTurnEnd(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = null;
      this.logger.log('WebSocket connection closed on TURN_END');
    }
    // PCM 데이터가 이미 동기적으로 파일에 기록되었으므로 추가 누적은 필요 없음.
    this.logger.log(`PCM data saved to file: ${this.tempFile}`);
    await this.sendSpeechResponse(this.currentTurnId, true, false);
  }

  // 상태별 공통 처리 함수
  private process(status: AudioStreamResponseStatus, isMaxTimeout: boolean): void {
    this.sendAudioStreamResponse(status);
    this.logger.log(`Processing: status=${AudioStreamResponseStatus[status]}, isMaxTimeout=${isMaxTimeout}`);
    if (status === AudioStreamResponseStatus.END) {
      // END 상태일 때 음성 응답 전송 수행
      this.sendSpeechResponse(this.currentTurnId, true, isMaxTimeout);
    }
  }

  // AudioStreamResponse 전송
  private sendAudioStreamResponse(status: AudioStreamResponseStatus): void {
    this.audioResponseSubject.next({ status });
  }

  // PCM -> WAV 변환 함수: ffmpeg를 사용하여 실제 변환 수행
  private async convertTurnWavFile(turnId: string, isEnd: boolean): Promise<string> {
    const wavDir = process.env.WAV_DIR || '/tmp/wav';
    const datePath = new Date().toISOString().split('T')[0]; // 예: "2025-03-16"
    const wavFile = path.join(wavDir, datePath, path.basename(this.tempFile) + '.wav');
    const wavDirFull = path.dirname(wavFile);
    if (!fs.existsSync(wavDirFull)) {
      fs.mkdirSync(wavDirFull, { recursive: true });
      this.logger.log(`WAV directory created: ${wavDirFull}`);
    }
    this.logger.log(`Converting PCM to WAV: ${this.tempFile} -> ${wavFile} (isEnd: ${isEnd})`);
    return new Promise<string>((resolve, reject) => {
      ffmpeg(this.tempFile)
        .inputFormat('s16le')
        .audioFrequency(16000)
        .audioChannels(1)
        .on('end', () => {
          this.logger.log(`PCM successfully converted to WAV: ${wavFile}`);
          resolve(wavFile);
        })
        .on('error', (err: any) => {
          this.logger.error(`Error converting PCM to WAV: ${err.message}`);
          reject(err);
        })
        .save(wavFile);
    });
  }

  // 음성 응답 전송 함수: WAV 파일을 multipart/form-data 형식으로 HTTP POST 요청
  private async sendSpeechResponse(turnId: string, isEnd: boolean, isMaxTimeout: boolean): Promise<void> {
    try {
      const wavFile = await this.convertTurnWavFile(turnId, isEnd);
      this.logger.log(`Sending speech response for turnId: ${turnId} using file: ${wavFile} (isEnd: ${isEnd}, isMaxTimeout: ${isMaxTimeout})`);

      const formData = new FormData();
      formData.append('file', fs.createReadStream(wavFile), {
        filename: path.basename(wavFile),
        contentType: 'audio/wav',
      });

      const response = await axios.post('http://epd.mago52.com:9003/speech2text/run', formData, {
        headers: {
          ...formData.getHeaders(),
          'accept': 'application/json',
        },
      });
      this.logger.log(`Speech response received: ${JSON.stringify(response.data)}`);
    } catch (error: any) {
      this.logger.error('Error sending speech response:', error.message);
    }
  }

  // Observable for audio responses as AudioStreamResponse.
  getAudioResponseStream(): Observable<{ status: AudioStreamResponseStatus }> {
    return this.audioResponseSubject.asObservable();
  }

  // (Optional) For delivery stream responses if needed.
  getDeliveryStream(): Observable<any> {
    return this.deliverySubject.asObservable();
  }
}
