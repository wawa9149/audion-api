import { Module } from '@nestjs/common';
import { SohriModule } from './modules/sohri/sohri.module';

@Module({
  imports: [SohriModule],
})
export class AppModule { }
