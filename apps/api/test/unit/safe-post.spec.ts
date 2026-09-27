import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { safeLookup, safePost } from '../../src/modules/webhooks/safe-post';

describe('safePost (webhooks sem DNS rebinding)', () => {
  let server: http.Server;
  let port: number;
  const received: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push(body);
        res.writeHead(302, { Location: 'http://169.254.169.254/' }).end('segredo-do-cliente');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('recusa hosts que resolvem para endereço interno no momento da conexão', async () => {
    const url = new URL(`http://localhost:${port}/hook`);
    await expect(safePost(url, { 'Content-Type': 'application/json' }, '{}', { timeoutMs: 3000, allowPrivate: false })).rejects.toMatchObject({
      code: 'EBLOCKEDADDRESS',
    });
    expect(received).toHaveLength(0);
  });

  it('em desenvolvimento (destinos privados permitidos) entrega e não segue redirecionamento', async () => {
    const res = await safePost(new URL(`http://localhost:${port}/hook`), { 'Content-Type': 'application/json' }, '{"a":1}', {
      timeoutMs: 3000,
      allowPrivate: true,
    });
    expect(res.status).toBe(302);
    expect(received).toEqual(['{"a":1}']);
  });

  it('lookup bloqueia localhost', async () => {
    const err = await new Promise<unknown>((resolve) => safeLookup('localhost', {}, (e) => resolve(e)));
    expect(err).toMatchObject({ code: 'EBLOCKEDADDRESS' });
  });
});
