// src/sohri.gateway.ts (Socket.IO 기반 WebSocket Gateway)
import {
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { SohriService } from './sohri.service';

@WebSocketGateway({ path: '/ws', cors: true })
export class SohriGateway implements OnGatewayInit {
  @WebSocketServer()
  server: Server;

  constructor(private readonly sohriService: SohriService) { }

  afterInit(server: Server) {
    this.sohriService.setServer(server);
    this.sohriService.getDeliveryStream().subscribe((deliveryData) => {
      const client = this.sohriService.getClientByTurnId(deliveryData.turnId);
      if (client) {
        client.emit('delivery', deliveryData);
      }
    });
  }

  @SubscribeMessage('eventRequest')
  handleEvent(client: Socket, data: { event: number }) {
    const turnId = this.sohriService.handleEvent(data, client);
    client.emit('eventResponse', { turnId });
  }

  @SubscribeMessage('audioStream')
  handleAudio(client: Socket, data: { turnId: string; content: string }) {
    const buffer = Buffer.from(data.content, 'base64');
    this.sohriService.processAudioBuffer({
      turnId: data.turnId,
      content: buffer,
    });
  }
}
