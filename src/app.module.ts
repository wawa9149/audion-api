// src/app.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SohriModule } from './sohri/sohri.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: `env/.env.${process.env.NODE_ENV || 'dev'}`,
    }),
    // MongooseModule.forRootAsync({
    //   imports: [ConfigModule],
    //   useFactory: (config: ConfigService) => ({
    //     uri: `mongodb://${config.get('MONGODB_HOST')}:${config.get('MONGODB_PORT')}`,
    //     dbName: config.get('MONGODB_NAME'),
    //     user: config.get('MONGODB_USER'),
    //     pass: config.get('MONGODB_PASS'),
    //     authSource: config.get('MONGODB_AUTH_DB') || 'admin',
    //   }),
    //   inject: [ConfigService],
    // }),
    SohriModule,
  ],
})
export class AppModule { }