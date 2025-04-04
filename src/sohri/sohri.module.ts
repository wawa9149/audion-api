// src/sohri/sohri.module.ts
import { Module } from '@nestjs/common';
import { SohriService } from './sohri.service';
import { SohriGateway } from './sohri.gateway';
import { WebSocketService } from './websocket.service';
import { FileService } from './file.service';
import { SpeechService } from './speech.service';

@Module({
  providers: [
    SohriService,
    SohriGateway,
    WebSocketService,
    FileService,
    SpeechService,
  ],
  exports: [SohriService],
})
export class SohriModule { }