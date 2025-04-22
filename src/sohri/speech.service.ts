// src/sohri/speech.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as FormData from 'form-data';
import axios from 'axios';
import { AudioEncoderService } from './audio/audio-encoder.service';

type Env = 'dev' | 'stage' | 'prod';

@Injectable()
export class SpeechService {
  private readonly logger = new Logger(SpeechService.name);

  // NODE_ENV 값에 따른 기본 URL 매핑
  private readonly defaultUrls: Record<Env, string> = {
    dev: 'http://tiro.mago52.com:9004/speech2text/run',
    stage: 'http://sohri.mago52.com:9004/speech2text/run',
    prod: 'http://mago-s2t-basic-aws:59004/speech2text/run',
  };
  private readonly defaultBatchUrls: Record<Env, string> = {
    dev: 'http://tiro.mago52.com:9004/speech2text/runs',
    stage: 'http://sohri.mago52.com:9004/speech2text/runs',
    prod: 'http://mago-s2t-basic-aws:59004/speech2text/runs',
  };

  constructor(
    private readonly configService: ConfigService,
    private readonly audioEncoder: AudioEncoderService,
  ) { }

  /** 현재 애플리케이션 실행 환경을 'dev'|'stage'|'prod' 로 변환 */
  private get apiEnv(): Env {
    const raw = this.configService.get<string>('NODE_ENV')?.toLowerCase();
    if (raw === 'prod') return 'prod';
    if (raw === 'stage') return 'stage';
    return 'dev';
  }

  /** 단건 STT API URL */
  private get speechApiUrl(): string {
    // 환경변수로 직접 지정된 값이 있으면 그걸 쓰고, 없으면 defaultUrls 에서 꺼내고
    return (
      this.configService.get<string>('SPEECH_API_URL')
      ?? this.defaultUrls[this.apiEnv]
    );
  }

  /** 배치 STT API URL */
  private get speechBatchApiUrl(): string {
    return (
      this.configService.get<string>('SPEECH_API_BATCH_URL')
      ?? this.defaultBatchUrls[this.apiEnv]
    );
  }

  async sendSpeechResponse(
    sessionId: string,
    pcmBuffer: Buffer,
    startChunk?: number,
    endChunk?: number,
  ) {
    const url = this.speechApiUrl;
    const resultRoot = this.configService.get<string>('RESULT_DIR') ?? './results';
    const datePath = new Date().toISOString().split('T')[0];
    const targetDir = path.join(resultRoot, datePath, sessionId);
    fs.mkdirSync(targetDir, { recursive: true });

    const filename = `${sessionId}_${startChunk ?? '0'}-${endChunk ?? 'end'}.mp3`;
    const wavPath = path.join(targetDir, filename);
    const mp3Data = await this.audioEncoder.pcmToMp3(pcmBuffer, 16000, 1);
    fs.writeFileSync(wavPath, mp3Data);

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
      fs.unlinkSync(wavPath);
      fs.rmdirSync(targetDir, { recursive: true });

      return {
        sessionId,
        speech: response.data.content,
      };
    } catch (err: any) {
      this.logger.error(`STT 요청 실패: ${err.message}`);
      return null;
    }
  }

  async sendBatchSpeechResponse(sttInputList: {
    sessionId: string;
    pcmBuffer: Buffer;
    start: number;
    end: number;
  }[]): Promise<{ sessionId: string; result: any }[]> {
    const url = this.speechBatchApiUrl;
    const resultRoot = this.configService.get<string>('RESULT_DIR') ?? './results';
    const datePath = new Date().toISOString().split('T')[0];
    const targetDir = path.join(resultRoot, datePath);
    fs.mkdirSync(targetDir, { recursive: true });

    const form = new FormData();
    const sessionIdMap = new Map<string, string>();

    for (const { sessionId, pcmBuffer, start, end } of sttInputList) {
      const utteranceId = `${sessionId}_${start}-${end}`;
      const mp3Data = await this.audioEncoder.pcmToMp3(pcmBuffer, 16000, 1);
      const filePath = path.join(targetDir, `${utteranceId}.mp3`);
      fs.writeFileSync(filePath, mp3Data);

      sessionIdMap.set(utteranceId, sessionId);
      form.append('files', fs.createReadStream(filePath), {
        filename: `${utteranceId}.mp3`,
        contentType: 'audio/mp3',
      });
    }

    try {
      const response = await axios.post(url, form, {
        headers: {
          ...form.getHeaders(),
          accept: 'application/json',
          Bearer: this.configService.get<string>('SPEECH_API_TOKEN'),
        },
      });

      const utterances = response.data.content.result.utterances || [];
      const results = utterances
        .map((u: any) => {
          const sid = sessionIdMap.get(u.id);
          if (!sid) {
            this.logger.error(`Session ID not found for utterance ID: ${u.id}`);
            return null;
          }
          return { sessionId: sid, result: { speech: u } };
        })
        .filter((x): x is { sessionId: string; result: any } => !!x);

      this.logger.log(`Batch STT response: ${JSON.stringify(results)}`);
      return results;
    } catch (err: any) {
      this.logger.error(`Batch STT 요청 실패: ${err.message}`);
      return [];
    }
  }
}
