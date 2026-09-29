import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleChat, type ChatRequestBody } from './chat.ts';
import { env } from './env.ts';

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendText(res: ServerResponse, status: number, text: string) {
	res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
}

function isChatRequestBody(body: unknown): body is ChatRequestBody {
	return typeof body === 'object' && body !== null && Array.isArray((body as ChatRequestBody).messages);
}

const server = createServer(async (req, res) => {
	const origin = req.headers.origin;
	if (origin && env.ALLOWED_ORIGINS.includes(origin)) {
		res.setHeader('Access-Control-Allow-Origin', origin);
		res.setHeader('Vary', 'Origin');
	}

	const { pathname } = new URL(req.url ?? '/', 'http://localhost');

	if (req.method === 'OPTIONS') {
		res.writeHead(204, {
			'Access-Control-Allow-Methods': 'POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
			'Access-Control-Max-Age': '86400',
		}).end();
		return;
	}

	if (req.method === 'GET' && pathname === '/health') {
		res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
		return;
	}

	if (req.method === 'POST' && pathname === '/chat') {
		let body: unknown;
		try {
			body = await readJson(req);
		} catch {
			return sendText(res, 400, 'Invalid JSON body.');
		}
		if (!isChatRequestBody(body)) {
			return sendText(res, 400, 'Expected a JSON body of { id, messages }.');
		}

		const abort = new AbortController();
		res.on('close', () => {
			if (!res.writableFinished) abort.abort();
		});

		await handleChat(body, res, abort.signal);
		return;
	}

	sendText(res, 404, 'Not found.');
});

server.listen(env.PORT, () => {
	console.log(`[agent] listening on http://localhost:${env.PORT} (allowed origins: ${env.ALLOWED_ORIGINS.join(', ')})`);
});
