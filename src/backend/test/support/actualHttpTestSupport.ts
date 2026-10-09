import { request as httpRequest } from 'node:http';

// Send real HTTP to an isolated server, preserving the original Host for LAN tests.
export async function requestTestServer(
  origin: string,
  request: Request,
  timeoutMilliseconds = 10_000,
): Promise<Response> {
  const source = new URL(request.url);
  const body = request.body
    ? Buffer.from(await request.arrayBuffer())
    : undefined;
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      `${origin}${source.pathname}${source.search}`,
      {
        method: request.method,
        headers: {
          ...Object.fromEntries(request.headers),
          host: source.host,
          ...(body ? { 'content-length': String(body.length) } : {}),
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on('error', reject);
        incoming.on('end', () => {
          const headers = new Headers();
          for (let i = 0; i < incoming.rawHeaders.length; i += 2)
            headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
          resolve(
            new Response(new Uint8Array(Buffer.concat(chunks)), {
              status: incoming.statusCode,
              headers,
            }),
          );
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.setTimeout(timeoutMilliseconds, () =>
      outgoing.destroy(new Error('Isolated HTTP request timed out')),
    );
    outgoing.end(body);
  });
}
