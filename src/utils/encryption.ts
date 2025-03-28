// src/utils/encryption.ts
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const algorithm = 'aes-256-cbc';
const ivLength = 16;

function getKey(): Buffer {
  const keyPath = path.join(process.cwd(), 'secrets/.env.enc.key');
  return Buffer.from(fs.readFileSync(keyPath, 'utf-8').trim(), 'utf-8');
}

export function encrypt(text: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(ivLength);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

export function decrypt(encrypted: string): string {
  const key = getKey();
  const [ivHex, dataHex] = encrypted.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encryptedText = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
  return decrypted.toString('utf8');
}
