import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class STTService {
  private readonly logger = new Logger(STTService.name);
  // 누적 오디오 데이터를 저장할 버퍼
  private audioBuffer: Buffer[] = [];

  // 클라이언트로부터 받은 오디오 청크 처리
  async processAudioBuffer(data: { audio: string }): Promise<void> {
    // base64 문자열로 전달된 오디오 데이터를 Buffer로 변환
    const chunk = Buffer.from(data.audio, 'base64');
    this.audioBuffer.push(chunk);

    // EPD API로 오디오 청크 전송 (실제 엔드포인트 및 헤더 정보 수정 필요)
    try {
      await axios.post('https://epd.api/endpoint', chunk, {
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      this.logger.log('EPD API 전송 성공');
    } catch (error) {
      this.logger.error('EPD API 전송 중 오류', error.message);
    }
  }

  // pause 이벤트 처리: 누적된 오디오 버퍼를 STT API에 보내 인식 결과를 받음
  async processPause(): Promise<{ text: string; confidence: number }> {
    // 누적된 오디오 데이터를 하나로 합침
    const fullAudioBuffer = Buffer.concat(this.audioBuffer);
    // 다음 처리를 위해 버퍼 초기화
    this.audioBuffer = [];

    try {
      const response = await axios.post('https://stt.api/recognize', fullAudioBuffer, {
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      this.logger.log('STT API 호출 성공');
      // 응답 데이터는 { text: string, confidence: number } 형태라고 가정
      return response.data;
    } catch (error) {
      this.logger.error('STT API 호출 중 오류', error.message);
      return { text: '', confidence: 0 };
    }
  }
}
