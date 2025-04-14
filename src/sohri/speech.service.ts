// src/sohri/speech.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as FormData from 'form-data';
import axios from 'axios';
import { pcmToWav } from './utils/pcm-to-wav';

@Injectable()
export class SpeechService {
  private readonly logger = new Logger(SpeechService.name);

  constructor(private readonly configService: ConfigService) { }

  /**
   * PCM Buffer를 WAV로 변환하고 STT API에 요청합니다.
   * @param sessionId - 세션 ID
   * @param pcmBuffer - PCM 버퍼 데이터
   * @param startChunk - 시작 청크 (디버깅용)
   * @param endChunk - 끝 청크 (디버깅용)
   */
  async sendSpeechResponse(
    sessionId: string,
    pcmBuffer: Buffer,
    startChunk?: number,
    endChunk?: number,
  ) {
    const resultRoot = process.env.RESULT_DIR || './results';
    const datePath = new Date().toISOString().split('T')[0];
    const targetDir = path.join(resultRoot, datePath, sessionId);
    fs.mkdirSync(targetDir, { recursive: true });

    // 디버그용 WAV 경로
    const wavPath = path.join(targetDir, `${sessionId}_${startChunk ?? '0'}-${endChunk ?? 'end'}.wav`);

    // WAV 변환
    const wavData = pcmToWav(pcmBuffer, 16000, 1, 16);
    fs.writeFileSync(wavPath, wavData);
    // this.logger.log(`Converted PCM to WAV: ${wavPath}`);

    // STT API 요청
    const url = this.configService.get<string>('SPEECH_API_URL') || 'http://sohri.mago52.com:9004/speech2text/run';
    const form = new FormData();
    form.append('file', fs.createReadStream(wavPath));

    try {
      const response = await axios.post(url, form, {
        headers: {
          ...form.getHeaders(),
          accept: 'application/json',
          Bearer: this.configService.get<string>('SPEECH_API_TOKEN'),
        },
      });

      this.logger.log(`Speech response: ${JSON.stringify(response.data)}`);
      return {
        sessionId,
        speech: response.data.content,
      };
    } catch (err: any) {
      this.logger.error(`STT 요청 실패: ${err.message}`);
      return null;
    }
  }
}
