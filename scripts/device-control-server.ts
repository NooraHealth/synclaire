/**
 * Host-side helper for the example app (iOS simulator / Android emulator).
 *
 *   GET  /config                  backends from test/integration/.state, fixtures, autorun flag
 *   POST /control/<country>       {action, uuid}: one fixed SQL statement from scenarios/probe.ts
 *   GET  /fixture/<country>.db    the WatermelonDB file from scripts/prepare-watermelon-fixture.ts
 *   GET  /fixture/<country>.json  its manifest
 *   POST /report                  {platform, name, ...}: saved to example/reports/<platform>-<name>.json
 *
 * Binds to 127.0.0.1 only (the Android emulator reaches it as 10.0.2.2).
 *
 *   node --import tsx scripts/device-control-server.ts [--autorun] [--port 8799]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionCountColumn, type CountryCode } from '../scenarios/countries';
import { controlSql, type ControlAction } from '../scenarios/probe';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(ROOT, 'test/integration/.state');
const FIXTURE_DIR = path.join(ROOT, 'example/fixtures');
const REPORT_DIR = path.join(ROOT, 'example/reports');

const args = process.argv.slice(2);
const autorun = args.includes('--autorun');
const portArg = args.indexOf('--port');
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 8799;
const CODES: Record<string, string> = { india: 'in', nepal: 'np', bangladesh: 'bd', indonesia: 'id' };
const NAME = /^[a-z]+$/;

interface State {
  country: string;
  baseUrl: string;
  database: string;
  container: string;
  seed: unknown;
}

function states(): Record<string, State> {
  if (!fs.existsSync(STATE_DIR)) return {};
  return Object.fromEntries(
    fs
      .readdirSync(STATE_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => [f.replace('.json', ''), JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8')) as State]),
  );
}

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json') {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length });
  res.end(data);
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && url.pathname === '/config') {
      const backends = Object.entries(states()).map(([key, s]) => {
        const u = new URL(s.baseUrl);
        return {
          key,
          code: CODES[key],
          port: Number(u.port),
          apiPath: u.pathname,
          seed: s.seed,
          hasFixture: fs.existsSync(path.join(FIXTURE_DIR, `${key}.db`)),
        };
      });
      return send(res, 200, { autorun, backends });
    }

    if (req.method === 'POST' && parts[0] === 'control' && parts.length === 2 && NAME.test(parts[1]!)) {
      const state = states()[parts[1]!];
      if (!state) return send(res, 404, { error: 'unknown country' });
      const { action, uuid } = (await readJson(req)) as { action: ControlAction; uuid: string };
      const code = CODES[parts[1]!] as CountryCode | undefined;
      if (!code) return send(res, 404, { error: 'unknown country' });
      const sql = controlSql(action, uuid, sessionCountColumn(code));
      const out = execFileSync('docker', ['exec', state.container, 'psql', '-U', 'postgres', '-d', state.database, '-tAc', sql])
        .toString()
        .trim();
      return send(res, 200, { result: out });
    }

    if (req.method === 'GET' && parts[0] === 'fixture' && parts.length === 2) {
      const m = /^([a-z]+)\.(db|json)$/.exec(parts[1]!);
      const file = m && path.join(FIXTURE_DIR, `${m[1]}.${m[2]}`);
      if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'no fixture' });
      return send(res, 200, fs.readFileSync(file), m![2] === 'db' ? 'application/octet-stream' : 'application/json');
    }

    if (req.method === 'POST' && url.pathname === '/report') {
      const report = (await readJson(req)) as { platform: string; name: string; prefix?: string; ok?: boolean; lines?: string[] };
      const prefix = report.prefix ?? '';
      if (!NAME.test(report.platform) || !/^[a-z-]+$/.test(report.name) || !/^[a-z]*$/.test(prefix)) {
        return send(res, 400, { error: 'bad report' });
      }
      const file = `${prefix ? `${prefix}-` : ''}${report.platform}-${report.name}.json`;
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      fs.writeFileSync(path.join(REPORT_DIR, file), JSON.stringify(report, null, 2));
      console.log(`[report] ${prefix ? `${prefix} ` : ''}${report.platform} ${report.name}: ${report.ok === false ? 'FAIL' : 'ok'}`);
      for (const line of report.lines ?? []) console.log(`  ${line}`);
      return send(res, 200, { saved: true });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`device control server on http://127.0.0.1:${PORT}${autorun ? ' (autorun)' : ''}`);
});
