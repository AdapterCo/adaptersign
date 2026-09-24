import { Inject, Injectable } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { AppError } from '../../common/errors/app-error';

/**
 * Armazenamento S3-compatible (Amazon S3, Cloudflare R2, MinIO) configurado por ambiente.
 * O bucket é PRIVADO: arquivos só saem pela API autenticada (nunca URL pública permanente).
 */
@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.bucket = config.STORAGE_BUCKET;
    this.client = new S3Client({
      region: config.STORAGE_REGION,
      endpoint: config.STORAGE_ENDPOINT,
      forcePathStyle: config.STORAGE_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: config.STORAGE_ACCESS_KEY_ID,
        secretAccessKey: config.STORAGE_SECRET_ACCESS_KEY,
      },
    });
  }

  /**
   * Grava objeto imutável: usa escrita condicional (If-None-Match: *) para que
   * um objeto existente NUNCA seja substituído silenciosamente.
   */
  async putImmutable(key: string, body: Buffer, contentType: string, sha256: string): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          IfNoneMatch: '*',
          Metadata: { sha256 },
        }),
      );
    } catch (err) {
      if (err instanceof S3ServiceException && (err.$metadata.httpStatusCode === 412 || err.name === 'PreconditionFailed')) {
        throw new AppError('STORAGE_OBJECT_EXISTS', 'Objeto já existe no armazenamento e não pode ser substituído.', 409);
      }
      throw err;
    }
  }

  async getBuffer(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`Objeto sem conteúdo: ${key}`);
    const bytes = await res.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async getStream(key: string): Promise<{ stream: Readable; contentLength?: number; contentType?: string }> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`Objeto sem conteúdo: ${key}`);
    const body = res.Body as unknown;
    if (!(body instanceof Readable)) throw new Error('Corpo do objeto não é um stream Node.js');
    return { stream: body, contentLength: res.ContentLength, contentType: res.ContentType };
  }

  /**
   * Remove objeto ÓRFÃO (gravado mas cuja transação no banco falhou).
   * Nunca usar para arquivos já referenciados por registros.
   */
  async deleteOrphan(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}

// Layout de chaves (nunca usa o nome original do arquivo).
export const StorageKeys = {
  originalVersion: (orgId: string, documentId: string, version: number, versionId: string) =>
    `documents/${orgId}/${documentId}/v${version}-${versionId}/original.pdf`,
  // `attemptId` torna a chave única por tentativa de finalização: uma retentativa nunca
  // colide com (nem substitui) arquivos de uma tentativa anterior.
  final: (orgId: string, documentId: string, envelopeId: string, attemptId: string) =>
    `documents/${orgId}/${documentId}/envelopes/${envelopeId}/final-${attemptId}.pdf`,
  evidence: (orgId: string, envelopeId: string, attemptId: string) => `envelopes/${orgId}/${envelopeId}/evidence-${attemptId}.pdf`,
  signatureAsset: (orgId: string, envelopeId: string, signerId: string) =>
    `signatures/${orgId}/${envelopeId}/${signerId}.png`,
};
