// src/sohri/speech.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as FormData from 'form-data';
import axios from 'axios';
import { AudioEncoderService } from './audio/audio-encoder.service';

@Injectable()
export class SpeechService {
  private readonly logger = new Logger(SpeechService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly audioEncoder: AudioEncoderService,
  ) { }

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

    const wavPath = path.join(targetDir, `${sessionId}_${startChunk ?? '0'}-${endChunk ?? 'end'}.mp3`);
    const wavData = this.audioEncoder.pcmToMp3(pcmBuffer, 16000, 1);
    // fs.writeFileSync(wavPath, wavData);

    const url = this.configService.get<string>('SPEECH_API_URL') || 'http://tiro.mago52.com:9004/speech2text/run';
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
    const resultRoot = process.env.RESULT_DIR || './results';
    const datePath = new Date().toISOString().split('T')[0];
    const targetDir = path.join(resultRoot, datePath);
    fs.mkdirSync(targetDir, { recursive: true });

    const form = new FormData();
    const sessionIdMap = new Map<string, string>(); // utteranceId -> sessionId

    for (const { sessionId, pcmBuffer, start, end } of sttInputList) {
      const utteranceId = `${sessionId}_${start}-${end}`;
      await this.audioEncoder.pcmToMp3(pcmBuffer, 16000, 1).then((mp3) => {
        fs.writeFileSync(`${targetDir}/${utteranceId}.mp3`, mp3);
      });

      sessionIdMap.set(utteranceId, sessionId);
      form.append('files', fs.createReadStream(`${resultRoot}/${datePath}/${utteranceId}.mp3`), {
        filename: `${utteranceId}.mp3`,
        contentType: 'audio/mp3',
      });
    }

    const url = this.configService.get<string>('SPEECH_API_BATCH_URL') || 'http://tiro.mago52.com:9004/speech2text/runs';

    try {
      const response = await axios.post(url, form, {
        headers: {
          ...form.getHeaders(),
          accept: 'application/json',
          Bearer: this.configService.get<string>('SPEECH_API_TOKEN'),
        },
      });

      const utterances = response.data.content.result.utterances || [];

      // 매핑 후 반환
      const results = utterances.map((u: any) => {
        const id: string = u.id; // eg. 428ba20e-7b58-xxxx_xx-xx
        const sessionId = sessionIdMap.get(id);
        if (!sessionId) {
          this.logger.error(`Session ID not found for utterance ID: ${id}`);
          return null;
        }
        return sessionId ? { sessionId, result: { speech: u } } : null;
      }).filter(Boolean);

      this.logger.log(`Batch STT response: ${JSON.stringify(results)}`);

      // 파일 삭제
      // for (const { sessionId, start, end } of sttInputList) {
      //   const utteranceId = `${sessionId}_${start}-${end}`;
      //   fs.unlinkSync(`${targetDir}/${utteranceId}.mp3`);
      // }

      return results;
    } catch (err) {
      this.logger.error(`Batch STT 요청 실패: ${err.message}`);
      return [];
    }
  }
}
