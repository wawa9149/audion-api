// src/sohri/schema/speech-result.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class SpeechResult extends Document {
  @Prop({ required: true })
  turnId: string;

  @Prop({ required: true })
  text: string;

  @Prop()
  audioPath: string;

  @Prop()
  duration?: number;

  @Prop()
  sampleRate?: number;

  @Prop()
  channels?: number;
}

export const SpeechResultSchema = SchemaFactory.createForClass(SpeechResult);
