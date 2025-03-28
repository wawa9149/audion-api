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

  async sendSpeechResponse(turnId: string, pcmFile: string, isMaxTimeout: boolean) {
    const resultRoot = process.env.RESULT_DIR || './results';
    const datePath = new Date().toISOString().split('T')[0];
    const targetDir = path.join(resultRoot, datePath, turnId);
    fs.mkdirSync(targetDir, { recursive: true });

    const wavPath = path.join(targetDir, `${turnId}.wav`);
    const resultPath = path.join(targetDir, `${turnId}_result.json`);

    // PCM → WAV 변환
    const pcmData = fs.readFileSync(pcmFile);
    const wavData = pcmToWav(pcmData, 16000, 1, 16);
    fs.writeFileSync(wavPath, wavData);

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

      // ✅ 결과 JSON 저장
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
