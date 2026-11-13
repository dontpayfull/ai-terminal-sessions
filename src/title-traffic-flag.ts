import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Claude Code 2.1.316 and later skip the generated conversation title
// (`ai-title`) when CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set. Follow
// Conversation Title lives on that title, so the extension looks for the
// variable where it can see it and offers to replace it with the four
// separate switches Claude Code documents as its equivalent. No vscode import
// here: the dialog is in title-traffic-prompt.ts.

export const TRAFFIC_FLAG = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC';
/** What the umbrella variable stands for, per the Claude Code settings docs. */
export const TRAFFIC_FLAG_PARTS = [
  'DISABLE_TELEMETRY',
  'DISABLE_ERROR_REPORTING',
  'DISABLE_BUG_COMMAND',
  'DISABLE_AUTOUPDATER',
] as const;

export type TrafficFlagFinding =
  | { kind: 'file'; path: string; line: number }
  | { kind: 'env' };

/** The Claude settings files the extension may read and edit: the user's, and
 *  each open workspace folder's shared and local one. Nothing else. */
export function claudeSettingsCandidates(workspaceFolders: readonly string[]): string[] {
  const out = [path.join(os.homedir(), '.claude', 'settings.json')];
  for (const folder of workspaceFolders) {
    if (!path.isAbsolute(folder)) continue;
    out.push(path.join(folder, '.claude', 'settings.local.json'), path.join(folder, '.claude', 'settings.json'));
  }
  return out;
}

const FLAG_LINE = new RegExp(`^(\\s*)"${TRAFFIC_FLAG}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|[^,\\s]+)\\s*(,?)\\s*$`);

function readEnvBlock(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as { env?: unknown };
    const env = parsed && typeof parsed === 'object' ? parsed.env : undefined;
    return env && typeof env === 'object' && !Array.isArray(env) ? (env as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Claude Code tests the variable for truthiness: any non-empty value sets it. */
function isSet(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '' && v !== false;
}

/** Where the variable is set, first hit wins: a settings file (which the
 *  extension can fix), else the environment the editor runs in (a shell
 *  export, which it cannot). */
export function findTrafficFlag(
  workspaceFolders: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): TrafficFlagFinding | undefined {
  for (const file of claudeSettingsCandidates(workspaceFolders)) {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const block = readEnvBlock(text);
    if (!block || !isSet(block[TRAFFIC_FLAG])) continue;
    const idx = text.split('\n').findIndex(l => l.includes(`"${TRAFFIC_FLAG}"`));
    return { kind: 'file', path: file, line: idx < 0 ? 0 : idx };
  }
  return isSet(env[TRAFFIC_FLAG]) ? { kind: 'env' } : undefined;
}

/**
 * The file's text with the variable replaced by the separate switches it
 * stands for (those not already there), or undefined when the file does not
 * set it or is not valid JSON. The variable's own line is rewritten in place,
 * so comments-free formatting, key order and indentation stay as they were;
 * a layout that edit cannot handle is re-serialized instead.
 */
export function replaceTrafficFlag(text: string): string | undefined {
  const block = readEnvBlock(text);
  if (!block || !(TRAFFIC_FLAG in block)) return undefined;
  const missing = TRAFFIC_FLAG_PARTS.filter(k => !(k in block));
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex(l => FLAG_LINE.test(l));
  if (at >= 0) {
    const m = FLAG_LINE.exec(lines[at])!;
    const indent = m[1];
    const comma = m[3];
    const added = missing.map((k, i) => `${indent}"${k}": "1"${i < missing.length - 1 || comma ? ',' : ''}`);
    const next = [...lines.slice(0, at), ...added, ...lines.slice(at + 1)];
    // The variable was the last key and nothing replaces it: the key before
    // it must lose its comma.
    if (added.length === 0 && !comma) {
      for (let i = at - 1; i >= 0; i--) {
        if (!next[i].trim()) continue;
        next[i] = next[i].replace(/,(\s*)$/, '$1');
        break;
      }
    }
    const out = next.join(eol);
    if (isFixed(out, block)) return out;
  }
  // Fallback: same content, standard two-space layout.
  try {
    const parsed = JSON.parse(text) as { env: Record<string, unknown> };
    const env: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed.env)) {
      if (k !== TRAFFIC_FLAG) { env[k] = v; continue; }
      for (const part of missing) env[part] = '1';
    }
    parsed.env = env;
    const out = JSON.stringify(parsed, null, 2) + (text.endsWith('\n') ? '\n' : '');
    return isFixed(out, block) ? out : undefined;
  } catch {
    return undefined;
  }
}

/** The edit is right when the result parses, the variable is gone, the four
 *  switches are there and every other key kept its value. */
function isFixed(out: string, before: Record<string, unknown>): boolean {
  const after = readEnvBlock(out);
  if (!after || TRAFFIC_FLAG in after) return false;
  if (!TRAFFIC_FLAG_PARTS.every(k => k in after)) return false;
  return Object.entries(before).every(([k, v]) => k === TRAFFIC_FLAG || JSON.stringify(after[k]) === JSON.stringify(v));
}

/** Apply the replacement to one of the known settings files. False when the
 *  path is not one of them, the file changed shape, or the write failed. */
export function fixTrafficFlagFile(file: string, workspaceFolders: readonly string[]): boolean {
  if (!claudeSettingsCandidates(workspaceFolders).includes(path.resolve(file))) return false;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const out = replaceTrafficFlag(text);
    if (out === undefined) return false;
    const mode = fs.statSync(file).mode & 0o777;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, out, { mode });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** What to do by hand when the variable comes from the shell. */
export function shellFixInstructions(): string {
  return [
    `Claude Code 2.1.316 and later do not generate conversation titles while ${TRAFFIC_FLAG} is set.`,
    '',
    `1. Remove the line that exports ${TRAFFIC_FLAG} from your shell profile (~/.zshrc, ~/.bash_profile, ~/.profile).`,
    '2. To keep everything else it turned off, add these lines in its place:',
    ...TRAFFIC_FLAG_PARTS.map(k => `   export ${k}=1`),
    '3. Restart the editor, then restart the running sessions.',
  ].join('\n');
}
