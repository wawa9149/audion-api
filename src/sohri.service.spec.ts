import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as fs from 'fs';
import * as path from 'path';
import * as ffmpeg from 'fluent-ffmpeg';
import axios from 'axios';
import * as FormData from 'form-data';

// 시스템 ffmpeg 경로 (환경변수 FFMPEG_PATH 또는 기본값)
ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH || '/usr/bin/ffmpeg');
console.log('Using ffmpeg at:', process.env.FFMPEG_PATH || '/usr/bin/ffmpeg');

const PROTO_PATH = path.join(__dirname, 'modules/sohri/sohri.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;
const sohriPackage = protoDescriptor.sohri;

// 단순 지연 함수 (밀리초 단위)
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * ffmpeg를 이용해 오디오 파일을 PCM 샘플 데이터로 디코딩합니다.
 * - 형식: s16le (16-bit signed little-endian PCM)
 * - 채널: mono (1 channel)
 * - 샘플레이트: 16000 Hz
 */
function extractAudioSamples(filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    ffmpeg(filePath)
      .format('s16le')
      .audioChannels(1)
      .audioFrequency(16000)
      .on('error', (err) => reject(err))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .pipe()
      .on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
  });
}

describe('SohriService gRPC Tests', () => {
  let client: any;
  let currentTurnId: string = '';

  beforeAll(() => {
    // gRPC 클라이언트 생성 (서버는 localhost:3000에서 실행 중이어야 함)
    client = new sohriPackage.CareCallEventService(
      'localhost:3000',
      grpc.credentials.createInsecure()
    );
  });

  afterAll(() => {
    if (client && client.close) { client.close(); }
  });

  test('should send all audio data with restart on END or TIMEOUT', async () => {
    currentTurnId = await new Promise((resolve, reject) => {
      client.eventRequest({ event: 10 }, (err: any, response: any) => {
        if (err) return reject(err);
        resolve(response.turnId);
      });
    });
    console.log('Initial turnId:', currentTurnId);

    const audioFilePath = path.join(__dirname, 'fixtures', 'test-audio.flac');
    const fileBuffer = await extractAudioSamples(audioFilePath);
    console.log('Extracted audio samples, size:', fileBuffer.length);

    const chunkSize = 8000;
    const numChunks = Math.ceil(fileBuffer.length / chunkSize);
    let currentChunk = 0;
    const allResponses: any[] = [];

    while (currentChunk < numChunks) {
      console.log('Starting new audioStream for turnId:', currentTurnId);
      const call = client.audioStream();
      let restartRequested = false;
      const responses: any[] = [];

      const streamPromise = new Promise<void>((resolve, reject) => {
        call.on('data', async (data: any) => {
          responses.push(data);
          console.log('Received response:', JSON.stringify(data));

          if (data.status === 'END' || data.status === 'TIMEOUT') {
            restartRequested = true;
            console.log('Detected restart condition with status:', data.status);

            console.log('Current stream ended.');
            resolve();

            if (restartRequested && currentChunk < numChunks) {
              console.log('Restart condition met. Sending TURN_END event.');
              await new Promise((resolve, reject) => {
                client.eventRequest({ event: 13 }, (err: any, response: any) => {
                  if (err) return reject(err);
                  console.log('TURN_END event processed, turnId:', response.turnId);
                  resolve(response.turnId);
                });
              });

              restartRequested = false;

              await delay(500);

              currentTurnId = await new Promise((resolve, reject) => {
                client.eventRequest({ event: 10 }, (err: any, response: any) => {
                  if (err) return reject(err);
                  resolve(response.turnId);
                });
              });
              console.log('New turnId received:', currentTurnId);
            }

          }
        });

        call.on('error', (error: any) => reject(error));

        call.on('end', async () => {
          console.log('Audio stream ended');
          resolve();
        });
      });

      while (currentChunk < numChunks && !restartRequested) {
        const start = currentChunk * chunkSize;
        const end = Math.min((currentChunk + 1) * chunkSize, fileBuffer.length);
        const chunk = Buffer.from(fileBuffer.subarray(start, end));
        const request = {
          turnId: currentTurnId,
          content: chunk,
          ttsStatus: 0,
        };
        call.write(request);
        console.log(`Sent chunk ${currentChunk + 1}/${numChunks} on current stream`);
        currentChunk++;
        await delay(500);
      }

      call.end();
      await streamPromise;
      console.log(`Stream responses for current stream: ${JSON.stringify(responses)}`);
      allResponses.push(...responses);
    }

    console.log('All chunks sent. Sending final TURN_END event.');
    await new Promise((resolve, reject) => {
      client.eventRequest({ event: 13 }, (err: any, response: any) => {
        if (err) return reject(err);
        console.log('Final TURN_END event processed, turnId:', response.turnId);
        resolve(response.turnId);
      });
    });

    console.log('Final audio stream responses received:');
    allResponses.forEach((res, idx) => {
      console.log(`Response ${idx + 1}: ${JSON.stringify(res)}`);
    });

    expect(allResponses.length).toBeGreaterThan(0);
  }, 60000);
});

