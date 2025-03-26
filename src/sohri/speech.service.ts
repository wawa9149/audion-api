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
    const wavDir = process.env.WAV_DIR || '/tmp/wav';
    const datePath = new Date().toISOString().split('T')[0];
    const wavPath = path.join(wavDir, datePath, `${turnId}.wav`);
    fs.mkdirSync(path.dirname(wavPath), { recursive: true });

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

      return {
        turnId,
        action: 1, // SPEECH_TO_TEXT
        speech: response.data.content,
      };
    } catch (err: any) {
      this.logger.error('Failed to send speech response', err.message);
    }
  }
}
