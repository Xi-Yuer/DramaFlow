import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';

@Injectable()
export class SecretsService {
  private key(): Buffer {
    const encoded = process.env.CREDENTIAL_ENCRYPTION_KEY;
    if (!encoded) throw new Error('CREDENTIAL_ENCRYPTION_KEY 未配置');
    if (!/^[a-f0-9]{64}$/i.test(encoded))
      throw new Error('CREDENTIAL_ENCRYPTION_KEY 必须是 32 字节密钥的十六进制表示（64 个字符）');
    return Buffer.from(encoded, 'hex');
  }
  encrypt(value: string, ownerId: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), nonce);
    cipher.setAAD(Buffer.from(ownerId));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [
      'v1',
      nonce.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }
  decrypt(envelope: string, ownerId: string): string {
    const [version, nonce, tag, ciphertext] = envelope.split('.');
    if (version !== 'v1' || !nonce || !tag || ciphertext === undefined)
      throw new Error('凭证密文格式错误');
    const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(nonce, 'base64url'));
    decipher.setAAD(Buffer.from(ownerId));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
