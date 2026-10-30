import { LoggerService } from '@nestjs/common';
import * as winston from 'winston';
import 'winston-daily-rotate-file';

/**
 * لاگ برنامه در فایل، نه کنسول (چاپ در کنسول کند است): LOG_DIR/<نام>-<تاریخ>.log، هر روز فایل تازه، ۲۰ مگابایت حداکثر،
 * ۱۴ روز نگهداری و قدیمی‌ها فشرده.
 *   telegram، bale، rubika، eitaa، whatsapp   لاگ هر پیام‌رسان (از اسم سرویس یا اول پیام)
 *   app                                        بقیه
 *   error                                      همه‌ی خطاها، از هر جا
 * LOG_CONSOLE: error (پیش‌فرض: فقط خطاها در کنسول، برای docker compose logs)، all، یا off.
 */
const MESSENGERS = ['telegram', 'bale', 'rubika', 'eitaa', 'whatsapp'] as const;
type LogFile = (typeof MESSENGERS)[number] | 'app';

const line = winston.format.printf(({ timestamp, level, message, context, trace }) =>
  `${timestamp} ${level.toUpperCase().padEnd(5)} [${context ?? '-'}] ${message}${trace ? `\n${trace}` : ''}`,
);

function rotating(name: string, level?: string): winston.transport {
  return new winston.transports.DailyRotateFile({
    dirname: process.env.LOG_DIR || 'logs',
    filename: `${name}-%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d',
    level,
  });
}

let files: Record<LogFile, winston.Logger> | undefined;

function loggers(): Record<LogFile, winston.Logger> {
  if (files) return files;
  const format = winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), line);
  const errors = rotating('error', 'error');
  const consoleMode = process.env.LOG_CONSOLE || 'error';
  const console = consoleMode === 'off' ? [] : [new winston.transports.Console({ level: consoleMode === 'all' ? 'debug' : 'error' })];
  const make = (name: LogFile) =>
    winston.createLogger({ level: process.env.LOG_LEVEL || 'info', format, transports: [rotating(name), errors, ...console] });
  files = Object.fromEntries([...MESSENGERS, 'app'].map((name) => [name, make(name as LogFile)])) as Record<LogFile, winston.Logger>;
  return files;
}

/** Which file: the messenger in the service's name (TelegramBotService, BaleChannelService …) or at the start of the message. */
function fileOf(context: string | undefined, message: string): LogFile {
  const name = `${context ?? ''} ${message.slice(0, 20)}`.toLowerCase();
  return MESSENGERS.find((messenger) => name.includes(messenger)) ?? 'app';
}

/** The log of one messenger, for libraries with their own logger (Baileys' pino). */
export function messengerLog(messenger: (typeof MESSENGERS)[number]): winston.Logger {
  return loggers()[messenger];
}

/** Nest's logger for the whole app: app.useLogger(new AppLogger()). */
export class AppLogger implements LoggerService {
  private write(level: string, message: unknown, context?: string, trace?: string) {
    const text = message instanceof Error ? message.message : typeof message === 'string' ? message : JSON.stringify(message);
    loggers()[fileOf(context, text)].log({ level, message: text, context, trace });
  }

  log(message: unknown, context?: string) {
    this.write('info', message, context);
  }

  // Nest: error(message, context) when there is no error, error(message, error | stack, context) when there is one
  error(message: unknown, traceOrContext?: unknown, context?: string) {
    const onlyContext = context === undefined && typeof traceOrContext === 'string' && !traceOrContext.includes('\n');
    const trace = onlyContext ? undefined : traceOrContext instanceof Error ? traceOrContext.stack : (traceOrContext as string | undefined);
    this.write('error', message, onlyContext ? (traceOrContext as string) : context, trace ?? (message instanceof Error ? message.stack : undefined));
  }

  warn(message: unknown, context?: string) {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string) {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string) {
    this.write('verbose', message, context);
  }
}
