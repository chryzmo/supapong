/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import type { TestProject } from 'vitest/node';

export interface StackInfo {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  jwtSecret: string;
}

declare module 'vitest' {
  interface ProvidedContext {
    stack: StackInfo;
  }
}

/** Reads the local stack's URL and keys once per run and hands them to every test file. */
export default function setup(project: TestProject): void {
  let output: string;
  try {
    output = execFileSync('npx', ['supabase', 'status', '-o', 'env'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new Error(
      'Integration tests need the local Supabase stack.  Start it with `npx supabase start` (and check DOCKER_HOST if you use Podman).',
    );
  }

  const env = new Map<string, string>();
  for (const line of output.split('\n')) {
    const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) env.set(match[1], match[2]);
  }

  const get = (key: string): string => {
    const value = env.get(key);
    if (!value) throw new Error(`\`supabase status\` did not report ${key}.`);
    return value;
  };

  project.provide('stack', {
    url: get('API_URL'),
    anonKey: get('ANON_KEY'),
    serviceRoleKey: get('SERVICE_ROLE_KEY'),
    jwtSecret: get('JWT_SECRET'),
  });
}
