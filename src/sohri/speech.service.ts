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
   * PCM 파일의 지정된 구간을 WAV로 변환하고 STT API를 호출합니다.
   * @param turnId - TURN 식별자
   * @param pcmFile - PCM 파일 경로
   * @param startChunk - (옵션) 변환할 시작 청크 번호 (청크 단위, 1 청크 = CHUNK_SIZE 바이트)
   * @param endChunk - (옵션) 변환할 마지막 청크 번호
   * @returns STT API의 응답 결과 (speech 내용 등)
   */
  async sendSpeechResponse(
    turnId: string,
    pcmFile: string,
    startChunk?: number,
    endChunk?: number,
  ) {
    const resultRoot = process.env.RESULT_DIR || './results';
    const datePath = new Date().toISOString().split('T')[0];
    const targetDir = path.join(resultRoot, datePath, turnId);
    fs.mkdirSync(targetDir, { recursive: true });

    const wavPath = path.join(targetDir, `${turnId}.wav`);
    const resultPath = path.join(targetDir, `${turnId}_result.json`);

    // 읽은 PCM 데이터 전체
    const pcmData = fs.readFileSync(pcmFile);

    // 청크 단위 기준 (여기서는 1600바이트, 각 샘플은 2바이트이므로 3200바이트 = 1 청크)
    const CHUNK_SIZE = 1600;
    const chunkByteSize = CHUNK_SIZE * 2;

    let dataToConvert: Buffer;
    if (startChunk !== undefined && endChunk !== undefined) {
      const startByte = startChunk * chunkByteSize;
      const endByte = endChunk * chunkByteSize;
      this.logger.debug(`Converting PCM from byte ${startByte} to ${endByte}`);
      const rawSlice = Uint8Array.prototype.slice.call(pcmData, startByte, endByte);
      dataToConvert = Buffer.from(rawSlice); // ✅ 안전하게 복사된 버퍼
    } else {
      dataToConvert = pcmData;
    }

    // PCM 데이터를 WAV로 변환 (pcmToWav 유틸리티 함수 사용)
    const wavData = pcmToWav(dataToConvert, 16000, 1, 16);
    fs.writeFileSync(wavPath, wavData);
    this.logger.log(`Converted PCM to WAV: ${wavPath}`);

    // STT API 호출
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

      // 결과 JSON 저장
      fs.writeFileSync(resultPath, JSON.stringify(response.data, null, 2));

      return {
        turnId,
        speech: response.data.content,
      };
    } catch (err: any) {
      this.logger.error('Failed to send speech response', err.message);
      return null;
    }
  }
}
