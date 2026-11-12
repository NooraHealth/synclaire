import { Platform } from 'react-native';

import type { BackendSeed, ControlAction } from '../../scenarios/probe';
import type { CountryCode } from '../../scenarios/countries';

/** The host machine as seen from the simulator (loopback) or the Android emulator (10.0.2.2). */
export const HOST = Platform.OS === 'android' ? '10.0.2.2' : '127.0.0.1';
export const CONTROL_URL = `http://${HOST}:8799`;
export const PLATFORM = Platform.OS === 'android' ? 'android' : 'ios';

export interface Backend {
  key: string;
  code: CountryCode;
  port: number;
  apiPath: string;
  seed: BackendSeed;
  hasFixture: boolean;
}

export interface HostConfig {
  autorun: boolean;
  backends: Backend[];
}

export function apiUrl(backend: Backend) {
  return `http://${HOST}:${backend.port}${backend.apiPath}`;
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export async function fetchConfig(): Promise<HostConfig> {
  return json<HostConfig>(await fetch(`${CONTROL_URL}/config`));
}

export async function control(backend: Backend, action: ControlAction, uuid: string): Promise<string> {
  const res = await fetch(`${CONTROL_URL}/control/${backend.key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, uuid }),
  });
  return (await json<{ result: string }>(res)).result;
}

export async function report(
  name: string,
  body: { ok: boolean; lines: string[]; [k: string]: unknown },
  prefix = '',
) {
  try {
    await fetch(`${CONTROL_URL}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, platform: PLATFORM, name, prefix }),
    });
  } catch {
    // Reporting is best-effort; results are also shown on screen.
  }
}
