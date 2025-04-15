// src/sohri.gateway.ts (Socket.IO 기반 WebSocket Gateway)

import {
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { SohriService } from './sohri.service';

// WebSocketGateway 설정
// path: '/ws' 로 클라이언트와 연결됨
// cors: true → 외부 접근 허용
@WebSocketGateway({ path: '/ws', cors: true })
export class SohriGateway implements OnGatewayInit {
  @WebSocketServer()
  server: Server; // WebSocket 서버 인스턴스

  constructor(private readonly sohriService: SohriService) { }

  // 서버 초기화 시 호출됨 (NestJS Lifecycle Hook)
  afterInit(server: Server) {
    // WebSocket 서버 인스턴스를 sohriService에 넘겨줌
    this.sohriService.setServer(server);

    // 인식 결과(delivery)가 생기면 클라이언트로 전달
    this.sohriService.getDeliveryStream().subscribe((deliveryData) => {
      const client = this.sohriService.getClientByTurnId(deliveryData.sessionId);
      if (client) {
        client.emit('delivery', deliveryData); // 개별 클라이언트로 전송
      }
    });
  }

  // 클라이언트로부터 'eventRequest' 메시지를 수신할 때 호출됨
  @SubscribeMessage('eventRequest')
  async handleEvent(client: Socket, data: { event: number }) {
    // TURN_START, TURN_END 등의 이벤트 처리
    const sessionId = await this.sohriService.handleEvent(data, client);

    // 클라이언트에 TURN ID를 응답
    client.emit('eventResponse', { sessionId });
  }

  // 클라이언트로부터 오디오 청크가 전송될 때 처리
  @SubscribeMessage('audioStream')
  handleAudio(client: Socket, data: { sessionId: string; content: string }) {
    // Base64로 인코딩된 오디오 데이터를 디코딩
    const buffer = Buffer.from(data.content, 'base64');

    // SohriService에 오디오 청크 전달
    this.sohriService.processAudioBuffer({
      sessionId: data.sessionId,
      content: buffer,
    });
  }
}
