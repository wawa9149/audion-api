import { Module } from '@nestjs/common';
import { STTService } from './stt.service';
import { STTController } from './stt.controller';

@Module({
  providers: [STTService],
  controllers: [STTController],
})
export class STTModule { }
