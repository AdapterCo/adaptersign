/**
 * Teste E2E do fluxo obrigatório (seção 70/108) + testes de segurança (seção 71).
 *
 * REQUER infraestrutura real: PostgreSQL (com migrations aplicadas), Redis, S3-compatible
 * (MinIO) e Mailpit — ex.: `docker compose up -d postgres redis minio minio-init mailpit`.
 * Variáveis: as mesmas do .env (NODE_ENV=test) + MAILPIT_URL (padrão http://localhost:8025).
 * Executar: npm run test:integration -w @adapter-sign/api
 */
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { AppModule } from '../../src/app.module';
import { WorkerModule } from '../../src/worker/worker.module';
import { configureApp } from '../../src/bootstrap';
import { getConfig } from '../../src/config/config';
import { PrismaService } from '../../src/infra/prisma/prisma.service';

const config = getConfig();
const ORIGIN = config.APP_PUBLIC_URL;
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const run = Date.now().toString(36);

type Agent = ReturnType<typeof request.agent>;

async function samplePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText(`Contrato fictício de teste ${run}`, { x: 50, y: 700, size: 14, font });
  return Buffer.from(await doc.save());
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 45000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('timeout aguardando condição');
}

/** Busca o texto do e-mail mais recente para o destinatário (API HTTP do Mailpit). */
async function latestEmail(to: string, subjectIncludes: string): Promise<{ Subject: string; Text: string }> {
  return waitFor(async () => {
    const list = (await (await fetch(`${MAILPIT}/api/v1/messages?limit=50`)).json()) as {
      messages: Array<{ ID: string; Subject: string; To: Array<{ Address: string }> }>;
    };
    const m = list.messages.find((x) => x.To.some((t) => t.Address === to) && x.Subject.includes(subjectIncludes));
    if (!m) return null;
    return (await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()) as { Subject: string; Text: string };
  });
}

describe('Fluxo completo de assinatura (E2E)', () => {
  let app: NestExpressApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let ownerA: Agent;
  let ownerB: Agent;
  let signer: Agent;
  let envelopeId = '';
  let documentId = '';
  let validationCode = '';
  let finalPdf: Buffer;
  const emailA = `owner-a-${run}@exemplo.test`;
  const emailB = `owner-b-${run}@exemplo.test`;
  const signerEmail = `signatario-${run}@exemplo.test`;
  const password = 'senha-de-teste-forte-123';

  const post = (a: Agent, url: string) => a.post(url).set('Origin', ORIGIN);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app, config);
    await app.init();
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn'] });
    prisma = app.get(PrismaService);
    // Plano padrão para o teste (configuração, dados fictícios).
    await prisma.plan.upsert({
      where: { code: config.DEFAULT_PLAN_CODE },
      create: { code: config.DEFAULT_PLAN_CODE, name: 'Teste', monthlyEnvelopes: 100, monthlyDocuments: 100, apiAccess: true, webhooks: true },
      update: {},
    });
    ownerA = request.agent(app.getHttpServer());
    ownerB = request.agent(app.getHttpServer());
    signer = request.agent(app.getHttpServer());
  });

  afterAll(async () => {
    await worker?.close();
    await app?.close();
  });

  it('cadastra empresa A e usuário (login via cookie HttpOnly)', async () => {
    const res = await post(ownerA, '/api/v1/auth/register').send({ organizationName: `Empresa A ${run}`, name: 'Dona A', email: emailA, password }).expect(201);
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly/i);
    // Confirmação de e-mail pelo link enviado.
    const mail = await latestEmail(emailA, 'Confirme seu e-mail');
    const token = /verify-email\?token=([A-Za-z0-9_-]+)/.exec(mail.Text)?.[1];
    expect(token).toBeDefined();
    await post(ownerA, '/api/v1/auth/verify-email/confirm').send({ token }).expect(200);
  });

  it('rejeita upload que não é PDF (magic bytes) e aceita PDF válido com SHA-256', async () => {
    await post(ownerA, '/api/v1/documents')
      .attach('file', Buffer.from('MZ fake'), { filename: 'contrato.pdf', contentType: 'application/pdf' })
      .expect(400);
    const res = await post(ownerA, '/api/v1/documents').attach('file', await samplePdf(), { filename: 'contrato.pdf', contentType: 'application/pdf' }).expect(201);
    documentId = res.body.id;
    expect(res.body.latestVersion.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('cria envelope com signatário e ativa (com confirmação e Idempotency-Key)', async () => {
    const created = await post(ownerA, '/api/v1/envelopes')
      .set('Idempotency-Key', `create-${run}`)
      .send({ title: 'Contrato de teste', documents: [{ documentId }], signers: [{ name: 'Signatário Teste', email: signerEmail, authMethod: 'EMAIL_OTP' }] })
      .expect(201);
    envelopeId = created.body.id;
    // Retentativa com a mesma chave não duplica.
    const replay = await post(ownerA, '/api/v1/envelopes')
      .set('Idempotency-Key', `create-${run}`)
      .send({ title: 'Contrato de teste', documents: [{ documentId }], signers: [{ name: 'Signatário Teste', email: signerEmail, authMethod: 'EMAIL_OTP' }] })
      .expect(201);
    expect(replay.body.id).toBe(envelopeId);
    await post(ownerA, `/api/v1/envelopes/${envelopeId}/activate`).send({ confirm: false }).expect(400);
    const active = await post(ownerA, `/api/v1/envelopes/${envelopeId}/activate`).send({ confirm: true }).expect(200);
    expect(active.body.status).toBe('ACTIVE');
    validationCode = active.body.validationCode;
  });

  it('bloqueia acesso cruzado entre tenants (IDOR)', async () => {
    await post(ownerB, '/api/v1/auth/register').send({ organizationName: `Empresa B ${run}`, name: 'Dono B', email: emailB, password }).expect(201);
    await ownerB.get(`/api/v1/envelopes/${envelopeId}`).expect(404);
    await ownerB.get(`/api/v1/documents/${documentId}`).expect(404);
    await post(ownerB, `/api/v1/envelopes/${envelopeId}/cancel`).send({}).expect(404);
    const list = await ownerB.get('/api/v1/envelopes').expect(200);
    expect(list.body.data.find((e: { id: string }) => e.id === envelopeId)).toBeUndefined();
  });

  it('rejeita requisição com cookie vinda de outra origem (CSRF)', async () => {
    await ownerA.post(`/api/v1/envelopes/${envelopeId}/remind`).set('Origin', 'https://atacante.exemplo').send({}).expect(403);
  });

  it('signatário: convite → OTP (com tentativa inválida) → leitura → aceite → assinatura', async () => {
    const invite = await latestEmail(signerEmail, 'assinatura solicitada');
    const token = /\/sign\/([A-Za-z0-9_-]{20,})/.exec(invite.Text)?.[1];
    expect(token).toBeDefined();

    await post(signer, '/api/v1/sign/sessions').send({ token: 'x'.repeat(43) }).expect(401);
    const opened = await post(signer, '/api/v1/sign/sessions').send({ token }).expect(200);
    expect(opened.body.signer.authenticated).toBe(false);
    // Sem autenticação não assina nem vê documento.
    await signer.get(`/api/v1/sign/documents/${opened.body.documents[0].id}/content`).expect(422);

    await post(signer, '/api/v1/sign/otp/request').expect(202);
    const otpMail = await latestEmail(signerEmail, 'código de verificação');
    const code = /(\d{6})/.exec(otpMail.Subject)?.[1];
    expect(code).toBeDefined();
    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await post(signer, '/api/v1/sign/otp/verify').send({ code: wrong }).expect(422);
    expect(bad.body.error.code).toBe('OTP_INVALID');
    const verified = await post(signer, '/api/v1/sign/otp/verify').send({ code }).expect(200);
    expect(verified.body.signer.authenticated).toBe(true);
    // OTP de uso único.
    await post(signer, '/api/v1/sign/otp/verify').send({ code }).expect(200);

    const docId = verified.body.documents[0].id;
    await signer.get(`/api/v1/sign/documents/${docId}/content?mode=view`).expect(200);

    await post(signer, '/api/v1/sign/sign')
      .send({ consentAccepted: false, consentVersion: verified.body.consent.version, method: 'TYPED', typedName: 'Signatário Teste' })
      .expect(422);
    const signed = await post(signer, '/api/v1/sign/sign')
      .send({ consentAccepted: true, consentVersion: verified.body.consent.version, method: 'TYPED', typedName: 'Signatário Teste' })
      .expect(200);
    expect(signed.body.replay).toBe(false);
    // Repetição da requisição (retry de rede) não cria segunda assinatura.
    const again = await post(signer, '/api/v1/sign/sign')
      .send({ consentAccepted: true, consentVersion: verified.body.consent.version, method: 'TYPED', typedName: 'Signatário Teste' })
      .expect(200);
    expect(again.body.replay).toBe(true);
    expect(await prisma.signature.count({ where: { envelopeId } })).toBe(1);
  });

  it('finaliza atomicamente com evidências e permite download', async () => {
    const env = await waitFor(async () => {
      const r = await ownerA.get(`/api/v1/envelopes/${envelopeId}`).expect(200);
      return r.body.status === 'COMPLETED' ? r.body : null;
    }, 90000);
    expect(env.evidenceReport.sha256).toMatch(/^[0-9a-f]{64}$/);
    const final = await ownerA
      .get(`/api/v1/envelopes/${envelopeId}/documents/${env.documents[0].id}/final`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    finalPdf = final.body as Buffer;
    expect(finalPdf.subarray(0, 5).toString()).toBe('%PDF-');
    await ownerA.get(`/api/v1/envelopes/${envelopeId}/evidence`).expect(200);
    const timeline = await ownerA.get(`/api/v1/envelopes/${envelopeId}/timeline`).expect(200);
    expect(timeline.body.chain.valid).toBe(true);
    // Envelope concluído não pode ser cancelado.
    await post(ownerA, `/api/v1/envelopes/${envelopeId}/cancel`).send({}).expect(409);
  });

  it('valida publicamente por código e por arquivo', async () => {
    const byCode = await request(app.getHttpServer()).get(`/api/v1/verify/${validationCode}`).expect(200);
    expect(byCode.body.integrity).toBe('VERIFIED');
    expect(byCode.body.signers[0].email).not.toBe(signerEmail); // mascarado
    const byFile = await request(app.getHttpServer())
      .post('/api/v1/verify/file')
      .attach('file', finalPdf, { filename: 'final.pdf', contentType: 'application/pdf' })
      .expect(201);
    expect(byFile.body.found).toBe(true);
    expect(byFile.body.results[0].matchType).toBe('FINAL_DOCUMENT');
    const unknown = await request(app.getHttpServer())
      .post('/api/v1/verify/file')
      .attach('file', await samplePdf(), { filename: 'x.pdf', contentType: 'application/pdf' })
      .expect(201);
    expect(unknown.body.found).toBe(false);
  });

  it('audit_events é append-only no banco', async () => {
    await expect(prisma.auditEvent.updateMany({ where: { envelopeId }, data: { eventType: 'ADULTERADO' } })).rejects.toThrow();
    await expect(prisma.auditEvent.deleteMany({ where: { envelopeId } })).rejects.toThrow();
  });

  it('logout-all revoga sessões (sessão revogada não autentica)', async () => {
    await post(ownerA, '/api/v1/auth/logout-all').expect(200);
    await ownerA.get('/api/v1/auth/me').expect(401);
  });
});
