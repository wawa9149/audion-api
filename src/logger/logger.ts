// src/config/winston.config.ts
import * as winston from 'winston';
import * as path from 'path';
import 'winston-daily-rotate-file';

const logDir = process.env.LOG_DIR || path.join(process.cwd(), 'logs');

const logFormat = winston.format.printf(({ timestamp, level, message, context }) => {
  return `[${timestamp}] ${level} [${context || 'App'}] ${message}`;
});

export const winstonConfig: winston.LoggerOptions = {
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat,
  ),
  transports: [
    // ✅ 일반 로그 (info 이상)
    new winston.transports.DailyRotateFile({
      dirname: `${logDir}/info`,
      filename: `%DATE%.log`,
      datePattern: 'YYYY-MM-DD',
      level: 'info',
      zippedArchive: true,
      maxSize: '10m',
      maxFiles: '14d',
    }),

    // ❗ 에러 로그만 별도 저장
    new winston.transports.DailyRotateFile({
      dirname: `${logDir}/error`,
      filename: `%DATE%.error.log`,
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      zippedArchive: true,
      maxSize: '10m',
      maxFiles: '30d',
    }),

    // 🖥️ 콘솔 출력 (dev에서 debug, prod에서 info)
    new winston.transports.Console({
      level: process.env.NODE_ENV === 'dev' ? 'debug' : 'info',
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat,
      ),
    }),
  ],
};
