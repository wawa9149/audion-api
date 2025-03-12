import { Module } from '@nestjs/common';
import { STTModule } from './modules/stt/stt.module';

@Module({
  imports: [STTModule],
})
export class AppModule { }
