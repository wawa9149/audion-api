/**
 * PCM 데이터를 WAV 파일 형식의 Buffer로 변환
 * @param pcmBuffer - PCM 데이터 Buffer
 * @param sampleRate - 샘플레이트 (예: 16000)
 * @param channels - 채널 수 (예: 1)
 * @param bitsPerSample - 비트 심도 (예: 16)
 * @returns WAV 파일 형식의 Buffer
 */
// src/sohri/utils/pcm-to-wav.ts
export function pcmToWav(
  pcmBuffer: Buffer,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): Buffer {
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
  header.writeUInt32LE(16, offset); offset += 4;
  header.writeUInt16LE(1, offset); offset += 2;
  header.writeUInt16LE(channels, offset); offset += 2;
  header.writeUInt32LE(sampleRate, offset); offset += 4;
  header.writeUInt32LE(byteRate, offset); offset += 4;
  header.writeUInt16LE(blockAlign, offset); offset += 2;
  header.writeUInt16LE(bitsPerSample, offset); offset += 2;

  header.write('data', offset); offset += 4;
  header.writeUInt32LE(dataSize, offset); offset += 4;

  return Buffer.concat([header, pcmBuffer]);
}
