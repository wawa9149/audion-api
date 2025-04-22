import { Injectable, Logger } from '@nestjs/common';
import * as ffmpeg from 'fluent-ffmpeg';
import { Readable, PassThrough } from 'stream';
import { once } from 'events';

@Injectable()
export class AudioEncoderService {
  private readonly logger = new Logger(AudioEncoderService.name);

  /**
   * PCM → MP3 변환 (FFmpeg 사용)
   * @param pcmBuffer - 원본 PCM 데이터
   * @param sampleRate - 샘플 레이트 (디폴트 16000)
   * @param channels - 채널 수 (디폴트 1)
   * @param bitrate - MP3 비트레이트 kbps (디폴트 32)
   * @returns 변환된 MP3 (Buffer)
   */
  async pcmToMp3(
    pcmBuffer: Buffer,
    sampleRate = 16000,
    channels = 1,
    bitrate = 32,
  ): Promise<Buffer> {
    if (!pcmBuffer || pcmBuffer.length === 0) {
      this.logger.error(`[pcmToMp3] 입력 PCM이 비어 있습니다. 변환 생략.`);
      return Buffer.alloc(0);
    }

    if (pcmBuffer.length < 6400) {
      this.logger.log(`[pcmToMp3] ⚠️ PCM 길이가 너무 짧음 (length=${pcmBuffer.length}), 인코딩 생략`);
      return Buffer.alloc(0); // 또는 throw
    }


    const inputStream = Readable.from(pcmBuffer);
    const outputStream = new PassThrough();
    const chunks: Buffer[] = [];

    // outputStream 이벤트 로깅
    outputStream.on('data', (chunk) => {
      // this.logger.log(`[pcmToMp3] outputStream 'data': ${chunk.length} bytes`);
      chunks.push(chunk);
    });
    outputStream.on('finish', () => {
      // this.logger.log(`[pcmToMp3] outputStream 'finish'`);
    });
    outputStream.on('close', () => {
      // this.logger.log(`[pcmToMp3] outputStream 'close'`);
    });
    outputStream.on('error', (err) => {
      this.logger.error(`[pcmToMp3] outputStream 'error': ${err.message}`);
    });

    // ffmpeg 커맨드 구성
    const cmd = ffmpeg(inputStream)
      .inputOptions([
        '-f', 's16le',
        '-ar', `${sampleRate}`,
        '-ac', `${channels}`,
      ])
      .audioCodec('libmp3lame')
      .audioBitrate(bitrate)
      .format('mp3');

    // ffmpeg 이벤트 로깅
    cmd.on('start', (commandLine) => {
      // this.logger.log(`[pcmToMp3][FFMPEG] start: ${commandLine}`);
    });
    cmd.on('codecData', (data) => {
      // this.logger.log(`[pcmToMp3][FFMPEG] codecData: ${JSON.stringify(data)}`);
    });
    cmd.on('progress', (progress) => {
      // this.logger.log(`[pcmToMp3][FFMPEG] progress: ${JSON.stringify(progress)}`);
    });
    cmd.on('error', (err, stdout, stderr) => {
      this.logger.error(`[pcmToMp3][FFMPEG] error: ${err.message}`);
      if (stdout) this.logger.error(`[pcmToMp3][FFMPEG] stdout: ${stdout}`);
      if (stderr) this.logger.error(`[pcmToMp3][FFMPEG] stderr: ${stderr}`);
    });
    cmd.on('end', () => {
      // this.logger.log(`[pcmToMp3][FFMPEG] end`);
    });

    // 파이프 연결
    cmd.pipe(outputStream);

    this.logger.log(`[pcmToMp3] ffmpeg pipe 연결 완료.`);

    // 스트림 종료(또는 에러) 대기
    await Promise.race([
      once(outputStream, 'end'),
      once(outputStream, 'error'),
    ]);

    const finalMp3 = Buffer.concat(chunks);
    this.logger.log(`[pcmToMp3] 변환 완료! finalMp3 size=${finalMp3.length} bytes`);

    return finalMp3;
  }


  /**
   * PCM → WAV 변환 (헤더 직접 작성)
   * @param pcmBuffer - 원본 PCM 데이터
   * @param sampleRate - 샘플 레이트
   * @param channels - 채널 수
   * @param bitsPerSample - 비트 심도 (16 등)
   * @returns 변환된 WAV (Buffer)
   */
  pcmToWav(
    pcmBuffer: Buffer,
    sampleRate: number,
    channels: number,
    bitsPerSample: number,
  ): Buffer {
    this.logger.log(`[pcmToWav] start: len=${pcmBuffer.length}, sr=${sampleRate}, ch=${channels}, bits=${bitsPerSample}`);

    const byteRate = (sampleRate * channels * bitsPerSample) / 8;
    const blockAlign = (channels * bitsPerSample) / 8;
    const dataSize = pcmBuffer.length;
    const headerSize = 44;
    const fileSize = dataSize + headerSize - 8;

    const header = Buffer.alloc(headerSize);
    let offset = 0;

    header.write('RIFF', offset); offset += 4;
    header.writeUInt32LE(fileSize, offset); offset += 4;
    header.write('WAVE', offset); offset += 4;

    header.write('fmt ', offset); offset += 4;
    header.writeUInt32LE(16, offset); offset += 4;  // Subchunk1Size: 16 for PCM
    header.writeUInt16LE(1, offset); offset += 2;   // AudioFormat: PCM=1
    header.writeUInt16LE(channels, offset); offset += 2;
    header.writeUInt32LE(sampleRate, offset); offset += 4;
    header.writeUInt32LE(byteRate, offset); offset += 4;
    header.writeUInt16LE(blockAlign, offset); offset += 2;
    header.writeUInt16LE(bitsPerSample, offset); offset += 2;

    header.write('data', offset); offset += 4;
    header.writeUInt32LE(dataSize, offset); offset += 4;

    const wavBuffer = Buffer.concat([header, pcmBuffer]);
    this.logger.log(`[pcmToWav] 변환 완료! finalWav size=${wavBuffer.length} bytes`);
    return wavBuffer;
  }
}
