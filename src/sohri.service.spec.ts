import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as fs from 'fs';
import * as path from 'path';
import * as ffmpeg from 'fluent-ffmpeg';
// 시스템에 설치된 ffmpeg 경로를 사용 (예: Linux에서는 '/usr/bin/ffmpeg')
// 환경변수 FFMPEG_PATH를 사용하는 방법도 있습니다.
const systemFfmpegPath = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';

ffmpeg.setFfmpegPath(systemFfmpegPath);

console.log('Using ffmpeg at:', systemFfmpegPath);


const PROTO_PATH = path.join(__dirname, 'modules/sohri/sohri.proto');

// Load the proto file.
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
function delay(ms: number) {
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

  beforeAll(() => {
    // gRPC 클라이언트 생성 (서버는 localhost:3000에서 실행 중이어야 함)
    client = new sohriPackage.CareCallEventService(
      'localhost:3000',
      grpc.credentials.createInsecure()
    );
  });

  afterAll(() => {
    // 클라이언트 종료 처리
    if (client && client.close) {
      client.close();
    }
  });

  test('should process eventRequest and stream audio chunks', async () => {
    // TURN_START 이벤트를 보내서 turnId 획득 (TURN_START = 10)
    const turnId: string = await new Promise((resolve, reject) => {
      client.eventRequest({ event: 10 }, (err: any, response: any) => {
        if (err) return reject(err);
        resolve(response.turnId);
      });
    });
    expect(turnId).toBeDefined();
    console.log('Received turnId:', turnId);

    // 오디오 파일에서 PCM 샘플 추출 (예: fixtures/test-audio.flac)
    const audioFilePath = path.join(__dirname, 'fixtures', 'test-audio.flac');
    const fileBuffer = await extractAudioSamples(audioFilePath);
    console.log('Extracted audio samples, size:', fileBuffer.length);

    // 양방향 스트리밍 RPC 호출
    const call = client.audioStream();
    const responses: any[] = [];

    // 스트림 이벤트들을 기다리는 Promise 생성
    const streamPromise = new Promise<void>((resolve, reject) => {
      call.on('data', (data: any) => {
        responses.push(data);
      });
      call.on('error', (error: any) => {
        reject(error);
      });
      call.on('end', () => {
        resolve();
      });
    });

    // 파일을 8000바이트씩 분할하여 500ms(0.5초) 간격으로 전송
    const chunkSize = 8000;
    const numChunks = Math.ceil(fileBuffer.length / chunkSize);
    for (let i = 0; i < numChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min((i + 1) * chunkSize, fileBuffer.length);
      const chunk = fileBuffer.slice(start, end);
      const request = {
        turnId: turnId,
        content: chunk,
        ttsStatus: 0, // 예시로 0 사용
      };
      call.write(request);
      console.log(`Sent chunk ${i + 1}/${numChunks}`);
      await delay(500);
    }

    // TURN_END 이벤트 전송 (TURN_END = 13)
    await new Promise((resolve, reject) => {
      client.eventRequest({ event: 13 }, (err: any, response: any) => {
        if (err) return reject(err);
        console.log('TURN_END event processed, turnId:', response.turnId);
        resolve(response.turnId);
      });
    });

    // 스트림 종료 및 대기
    call.end();
    await streamPromise;

    // 추가로 1초 대기하여 모든 비동기 핸들 정리
    await delay(1000);

    expect(responses.length).toBeGreaterThan(0);
  }, 40000);
});
