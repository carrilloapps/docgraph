#!/usr/bin/env node
/**
 * Interactive installer: detects installed AI agents (Claude Code, Cursor,
 * opencode, Gemini CLI, Codex CLI, Kiro, Antigravity, Hermes Agent) and wires
 * docgraph into each one using that agent's native MCP config format. Mirrors
 * `codegraph install`'s UX: auto-detect agents, prompt for non-interactive
 * confirmation, support `--yes` and `--target=<list>` for CI/scripting.
 *
 * Non-interactive mode is the default; pass `--interactive` to enable the
 * prompts. Each agent writes its own MCP server config and (where the agent
 * supports it) a marker-fenced section in its instructions file pointing at
 * `docgraph` MCP tools.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir, platform } from 'os';
import { dirname, join } from 'path';
import process from 'process';

interface AgentInstallOpts {
  projectPath: string;
  /** Portable launch command, already wrapped for the current platform. */
  command: string[];
  location: 'global' | 'local';
  marker: string;
}

interface AgentUninstallOpts {
  projectPath: string;
  location: 'global' | 'local';
}

interface AgentTarget {
  id: string;
  name: string;
  description: string;
  /** True when the agent's config or CLI is reachable. */
  detected(): Promise<boolean> | boolean;
  /** Write the MCP server config and instructions. */
  install(opts: AgentInstallOpts): Promise<void> | void;
  /** Inverse of install. */
  uninstall(opts: AgentUninstallOpts): Promise<void> | void;
}

/** Thrown by config writers to signal a non-fatal, per-agent skip (e.g. unparsable file). */
class ConfigSkipped extends Error {}

const PORTABLE_LAUNCH = ['npx', '-y', '-p', '@carrilloapps/docgraph', 'docgraph-mcp', 'serve'];

const AGENTS: AgentTarget[] = [
  claudeCodeAgent(),
  cursorAgent(),
  opencodeAgent(),
  geminiAgent(),
  codexAgent(),
  kiroAgent(),
  antigravityAgent(),
  hermesAgent(),
];

/** Wrap the portable launch command for the current platform (`cmd /c ...` on Windows). */
function resolveCommand(base: string[]): string[] {
  return platform() === 'win32' ? ['cmd', '/c', ...base] : base;
}

function claudeCodeAgent(): AgentTarget {
  return {
    id: 'claude',
    name: 'Claude Code',
    description: 'Anthropic’s Claude Code CLI (mcpServers in .mcp.json / ~/.claude.json)',
    detected: () => {
      const global = join(homedir(), '.claude.json');
      const local = join(process.cwd(), '.mcp.json');
      return existsSync(global) || existsSync(local);
    },
    install: ({ projectPath, command, location, marker }) => {
      const target = location === 'global' ? join(homedir(), '.claude.json') : join(projectPath, '.mcp.json');
      upsertMcpConfig(target, 'docgraph', command, 'stdio');
      appendInstructions(
        location === 'global' ? join(homedir(), '.claude', 'CLAUDE.md') : join(projectPath, 'CLAUDE.md'),
        marker,
      );
    },
    uninstall: ({ projectPath, location }) => {
      const target = location === 'global' ? join(homedir(), '.claude.json') : join(projectPath, '.mcp.json');
      removeMcpConfig(target, 'docgraph');
      removeInstructions(
        location === 'global' ? join(homedir(), '.claude', 'CLAUDE.md') : join(projectPath, 'CLAUDE.md'),
        INSTRUCTIONS_MARKER,
      );
    },
  };
}

function cursorAgent(): AgentTarget {
  return {
    id: 'cursor',
    name: 'Cursor',
    description: 'Cursor IDE (mcpServers in .cursor/mcp.json / ~/.cursor/mcp.json)',
    detected: () => existsSync(join(homedir(), '.cursor')) || existsSync(join(process.cwd(), '.cursor')),
    install: ({ projectPath, command, location }) => {
      const target = location === 'global' ? join(homedir(), '.cursor', 'mcp.json') : join(projectPath, '.cursor', 'mcp.json');
      upsertMcpConfig(target, 'docgraph', command, 'stdio');
    },
    uninstall: ({ projectPath, location }) => {
      const target = location === 'global' ? join(homedir(), '.cursor', 'mcp.json') : join(projectPath, '.cursor', 'mcp.json');
      removeMcpConfig(target, 'docgraph');
    },
  };
}

function opencodeAgent(): AgentTarget {
  return {
    id: 'opencode',
    name: 'opencode',
    description: 'opencode CLI (mcp{} block in opencode.json / ~/.config/opencode/opencode.json)',
    detected: () => {
      const global = join(homedir(), '.config', 'opencode', 'opencode.json');
      const local = join(process.cwd(), 'opencode.json');
      const localJsonc = join(process.cwd(), 'opencode.jsonc');
      return existsSync(global) || existsSync(local) || existsSync(localJsonc);
    },
    install: ({ projectPath, command, location, marker }) => {
      const file = location === 'global'
        ? join(homedir(), '.config', 'opencode', 'opencode.json')
        : existsSync(join(projectPath, 'opencode.jsonc'))
          ? join(projectPath, 'opencode.jsonc')
          : join(projectPath, 'opencode.json');
      upsertOpencodeConfig(file, 'docgraph', command);
      appendInstructions(
        location === 'global' ? join(homedir(), '.config', 'opencode', 'AGENTS.md') : join(projectPath, 'AGENTS.md'),
        marker,
      );
    },
    uninstall: ({ projectPath, location }) => {
      const file = location === 'global'
        ? join(homedir(), '.config', 'opencode', 'opencode.json')
        : existsSync(join(projectPath, 'opencode.jsonc'))
          ? join(projectPath, 'opencode.jsonc')
          : join(projectPath, 'opencode.json');
      removeOpencodeConfig(file, 'docgraph');
      removeInstructions(
        location === 'global' ? join(homedir(), '.config', 'opencode', 'AGENTS.md') : join(projectPath, 'AGENTS.md'),
        INSTRUCTIONS_MARKER,
      );
    },
  };
}

function geminiAgent(): AgentTarget {
  return {
    id: 'gemini',
    name: 'Gemini CLI',
    description: 'Google Gemini CLI (mcpServers in .gemini/settings.json / ~/.gemini/settings.json)',
    detected: () => existsSync(join(homedir(), '.gemini')) || existsSync(join(process.cwd(), '.gemini')),
    install: ({ projectPath, command, location }) => {
      const target = location === 'global' ? join(homedir(), '.gemini', 'settings.json') : join(projectPath, '.gemini', 'settings.json');
      upsertMcpConfig(target, 'docgraph', command, 'stdio');
    },
    uninstall: ({ projectPath, location }) => {
      const target = location === 'global' ? join(homedir(), '.gemini', 'settings.json') : join(projectPath, '.gemini', 'settings.json');
      removeMcpConfig(target, 'docgraph');
    },
  };
}

function codexAgent(): AgentTarget {
  return {
    id: 'codex',
    name: 'Codex CLI',
    description: 'OpenAI Codex CLI (TOML [mcp_servers.docgraph] in .codex/config.toml / ~/.codex/config.toml)',
    detected: () => existsSync(join(homedir(), '.codex')) || existsSync(join(process.cwd(), '.codex')),
    install: ({ projectPath, command, location }) => {
      const target = location === 'global' ? join(homedir(), '.codex', 'config.toml') : join(projectPath, '.codex', 'config.toml');
      upsertCodexToml(target, 'docgraph', command);
    },
    uninstall: ({ projectPath, location }) => {
      const target = location === 'global' ? join(homedir(), '.codex', 'config.toml') : join(projectPath, '.codex', 'config.toml');
      removeCodexToml(target, 'docgraph');
    },
  };
}

function kiroAgent(): AgentTarget {
  return {
    id: 'kiro',
    name: 'Kiro',
    description: 'Kiro IDE (mcpServers in .kiro/settings/mcp.json / ~/.kiro/settings/mcp.json)',
    detected: () => existsSync(join(homedir(), '.kiro')) || existsSync(join(process.cwd(), '.kiro')),
    install: ({ projectPath, command, location }) => {
      const target = location === 'global'
        ? join(homedir(), '.kiro', 'settings', 'mcp.json')
        : join(projectPath, '.kiro', 'settings', 'mcp.json');
      upsertMcpConfig(target, 'docgraph', command, 'stdio');
    },
    uninstall: ({ projectPath, location }) => {
      const target = location === 'global'
        ? join(homedir(), '.kiro', 'settings', 'mcp.json')
        : join(projectPath, '.kiro', 'settings', 'mcp.json');
      removeMcpConfig(target, 'docgraph');
    },
  };
}

/**
 * Google Antigravity IDE. There is a single well-known config location (no
 * separate project-local file is documented), so `location` is accepted for
 * interface symmetry but does not change the target path.
 */
function antigravityAgent(): AgentTarget {
  const target = () => join(homedir(), '.gemini', 'antigravity', 'mcp_config.json');
  return {
    id: 'antigravity',
    name: 'Antigravity',
    description: 'Google Antigravity IDE (mcpServers in ~/.gemini/antigravity/mcp_config.json)',
    detected: () => existsSync(dirname(target())),
    install: ({ command }) => {
      upsertMcpConfig(target(), 'docgraph', command, 'stdio');
    },
    uninstall: () => {
      removeMcpConfig(target(), 'docgraph');
    },
  };
}

function hermesAgent(): AgentTarget {
  return {
    id: 'hermes',
    name: 'Hermes Agent',
    // NOTE: Hermes Agent has no publicly documented MCP config schema at the
    // time of writing. This implementation follows the de-facto `mcpServers`
    // JSON convention shared by most MCP-compatible clients (Claude Code,
    // Cursor, Gemini CLI, Kiro, ...). Treat this integration as best-effort
    // and unverified until confirmed against official Hermes documentation.
    description: 'Hermes Agent (best-effort, unverified: mcpServers in .hermes/mcp.json / ~/.hermes/mcp.json)',
    detected: () => existsSync(join(homedir(), '.hermes')) || existsSync(join(process.cwd(), '.hermes')),
    install: ({ projectPath, command, location }) => {
      const target = location === 'global' ? join(homedir(), '.hermes', 'mcp.json') : join(projectPath, '.hermes', 'mcp.json');
      upsertMcpConfig(target, 'docgraph', command, 'stdio');
    },
    uninstall: ({ projectPath, location }) => {
      const target = location === 'global' ? join(homedir(), '.hermes', 'mcp.json') : join(projectPath, '.hermes', 'mcp.json');
      removeMcpConfig(target, 'docgraph');
    },
  };
}

const INSTRUCTIONS_MARKER = '<!-- docgraph:managed:start -->';

const KNOWN_BOOLEAN_FLAGS = new Set(['--interactive', '--yes', '--help', '-h']);
const KNOWN_VALUE_FLAG_PREFIXES = ['--target=', '--location=', '--print-config='];

/** `docgraph-install [install|uninstall] [projectPath] [flags]` usage text. */
function usage(): string {
  const agentList = AGENTS.map((a) => `    ${a.id.padEnd(11)} ${a.name} — ${a.description}`).join('\n');
  return `Usage: docgraph-install [uninstall] [projectPath] [options]

Modes:
  (default)               Install DocGraph's MCP config into detected agents
  uninstall               Remove DocGraph's MCP config from detected agents

Arguments:
  projectPath             Project directory (default: current working directory)

Options:
  --interactive           Prompt for confirmation instead of running non-interactively
  --yes                   Skip prompts and assume "local" unless --location is given
  --target=<ids>          Comma-separated agent ids to target (default: auto-detected)
  --location=<global|local>
                          Where to write config: global (~/...) or local (./)
  --print-config=<id>     Print the MCP config snippet for one agent id and exit
  -h, --help              Show this help message and exit

Supported agents:
${agentList}`;
}

/** True when `arg` is a recognized flag (boolean or `--name=value`). */
function isKnownFlag(arg: string): boolean {
  return KNOWN_BOOLEAN_FLAGS.has(arg) || KNOWN_VALUE_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix));
}

/** Detect installed agents and prompt (or auto-pick) which to configure. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    process.exitCode = 0;
    return;
  }

  const unknownFlag = args.find((a) => a.startsWith('-') && !isKnownFlag(a));
  if (unknownFlag) {
    console.error(`Unknown option: ${unknownFlag}\n`);
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const isInteractive = args.includes('--interactive') && process.stdin.isTTY;
  const isUninstall = args[0] === 'uninstall';
  const autoYes = args.includes('--yes');
  const targetFlag = args.find((a) => a.startsWith('--target='))?.split('=')[1];
  const locationFlag = args.find((a) => a.startsWith('--location='))?.split('=')[1] as 'global' | 'local' | undefined;
  const printConfigFlag = args.find((a) => a.startsWith('--print-config='))?.split('=')[1];
  const projectPath = args.find((a) => !a.startsWith('--')) ?? process.cwd();

  if (printConfigFlag) {
    const snippet = printConfigSnippet(printConfigFlag);
    if (snippet !== null) console.log(snippet);
    else process.exit(1);
    return;
  }

  const detected: AgentTarget[] = [];
  for (const agent of AGENTS) {
    try {
      if (await agent.detected()) detected.push(agent);
    } catch {
      // Detection failure just means the agent isn't installed.
    }
  }

  if (detected.length === 0) {
    console.log('No supported AI agents detected. Run `docgraph install --help` for manual setup.');
    process.exitCode = 0;
    return;
  }

  const targets = targetFlag
    ? AGENTS.filter((a) => targetFlag.split(',').includes(a.id))
    : detected;

  const location: 'global' | 'local' = locationFlag ?? (autoYes ? 'local' : await askLocation());
  const command = resolveCommand(PORTABLE_LAUNCH);

  console.log(`DocGraph installer — ${isUninstall ? 'uninstall' : 'install'} mode`);
  console.log(`Project: ${projectPath}`);
  console.log(`Target agents: ${targets.map((a) => a.name).join(', ')}`);
  console.log(`Location: ${location}`);
  console.log('');

  for (const agent of targets) {
    try {
      if (isUninstall) {
        await agent.uninstall({ projectPath, location });
        console.log(`  [${agent.id}] removed`);
      } else {
        await agent.install({ projectPath, command, location, marker: INSTRUCTIONS_MARKER });
        console.log(`  [${agent.id}] configured`);
      }
    } catch (err) {
      if (err instanceof ConfigSkipped) {
        console.warn(`  [${agent.id}] skipped: ${err.message}`);
      } else {
        console.error(`  [${agent.id}] failed: ${(err as Error).message}`);
      }
    }
  }

  console.log('');
  console.log(isUninstall ? 'Uninstall complete.' : 'Install complete. Restart your agent to load the MCP server.');
}

async function askLocation(): Promise<'global' | 'local'> {
  if (!process.stdin.isTTY) return 'local';
  // Lazily import readline to avoid pulling it in for non-interactive runs.
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Install MCP config globally (~/.config/<agent>) or locally (./)? [local/global] ');
    return answer.trim().toLowerCase().startsWith('g') ? 'global' : 'local';
  } finally {
    rl.close();
  }
}

/**
 * Merge a `mcpServers.<serverName>` entry into a JSON config file, preserving
 * every other key and server already present. If the file exists but fails
 * to parse, the file is left completely untouched and a `ConfigSkipped`
 * error is thrown so the caller can report a non-fatal warning instead of
 * clobbering the user's existing configuration.
 */
function upsertMcpConfig(filePath: string, serverName: string, command: string[], transport: string): void {
  let config: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, 'utf-8');
    try {
      config = raw.trim().length > 0 ? JSON.parse(raw) : {};
    } catch {
      throw new ConfigSkipped(
        `${filePath} could not be parsed as JSON — left untouched. Fix or remove the file and re-run install.`,
      );
    }
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const mcpServers = (config.mcpServers && typeof config.mcpServers === 'object') ? (config.mcpServers as Record<string, unknown>) : {};
  mcpServers[serverName] = { command: command[0], args: command.slice(1), type: transport };
  config.mcpServers = mcpServers;
  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Remove a `mcpServers.<serverName>` entry from a JSON config file. If the
 * file fails to parse it is left untouched and a `ConfigSkipped` error is
 * thrown (uninstall must never wipe a file it cannot safely edit).
 */
function removeMcpConfig(filePath: string, serverName: string): void {
  if (!existsSync(filePath)) return;
  const raw = readFileSync(filePath, 'utf-8');
  let config: Record<string, unknown>;
  try {
    config = raw.trim().length > 0 ? JSON.parse(raw) : {};
  } catch {
    throw new ConfigSkipped(
      `${filePath} could not be parsed as JSON — left untouched. Remove the "${serverName}" entry manually.`,
    );
  }
  const mcpServers = config.mcpServers as Record<string, unknown> | undefined;
  if (mcpServers && Object.prototype.hasOwnProperty.call(mcpServers, serverName)) {
    delete mcpServers[serverName];
  }
  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/** Strip JS/JSONC-style comments so `JSON.parse` can read an opencode.jsonc file. */
function stripJsonc(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Merge a `mcp.<serverName>` entry into opencode's config (JSON or JSONC),
 * preserving every other key already present. Malformed files are left
 * untouched — see `upsertMcpConfig` for the same non-destructive contract.
 */
function upsertOpencodeConfig(filePath: string, serverName: string, command: string[]): void {
  let config: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, 'utf-8');
    try {
      const cleaned = stripJsonc(raw);
      config = cleaned.trim().length > 0 ? JSON.parse(cleaned) : {};
    } catch {
      throw new ConfigSkipped(
        `${filePath} could not be parsed as JSON — left untouched. Fix or remove the file and re-run install.`,
      );
    }
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const mcp = (config.mcp && typeof config.mcp === 'object') ? (config.mcp as Record<string, unknown>) : {};
  mcp[serverName] = { type: 'local', command, enabled: true };
  config.mcp = mcp;
  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function removeOpencodeConfig(filePath: string, serverName: string): void {
  if (!existsSync(filePath)) return;
  const raw = readFileSync(filePath, 'utf-8');
  let config: Record<string, unknown>;
  try {
    const cleaned = stripJsonc(raw);
    config = cleaned.trim().length > 0 ? JSON.parse(cleaned) : {};
  } catch {
    throw new ConfigSkipped(
      `${filePath} could not be parsed as JSON — left untouched. Remove the "${serverName}" entry manually.`,
    );
  }
  const mcp = config.mcp as Record<string, unknown> | undefined;
  if (mcp && Object.prototype.hasOwnProperty.call(mcp, serverName)) {
    delete mcp[serverName];
  }
  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/** Escape a string for safe interpolation into a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Quote a value as a basic TOML string, escaping backslashes and quotes. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Build the `[<tableName>]` TOML block (plus any nested `.env` table) for a command. */
function buildTomlServerBlock(tableName: string, command: string[], env?: Record<string, string>): string {
  const [cmd, ...args] = command;
  const argsToml = `[${args.map(tomlString).join(', ')}]`;
  let block = `[${tableName}]\ncommand = ${tomlString(cmd)}\nargs = ${argsToml}\n`;
  if (env && Object.keys(env).length > 0) {
    block += `\n[${tableName}.env]\n`;
    for (const [key, value] of Object.entries(env)) {
      block += `${key} = ${tomlString(value)}\n`;
    }
  }
  return block;
}

/**
 * Remove a top-level `[tableName]` block (and any immediately-following
 * nested `[tableName.*]` sub-tables, e.g. an `.env` table) from raw TOML
 * text via line-oriented text manipulation — no TOML parser is used, so
 * every other table, key, and comment in the file is left byte-for-byte
 * intact. Returns the input unchanged if the table is not present.
 */
function removeTomlTable(text: string, tableName: string): string {
  const lines = text.split(/\r?\n/);
  const headerRe = new RegExp(`^\\[${escapeRegExp(tableName)}\\]\\s*$`);
  const nestedHeaderRe = new RegExp(`^\\[${escapeRegExp(tableName)}\\.[^\\]]+\\]`);
  const anyHeaderRe = /^\[.+\]\s*$/;

  const startIdx = lines.findIndex((line) => headerRe.test(line.trim()));
  if (startIdx === -1) return text;

  let endIdx = startIdx + 1;
  while (endIdx < lines.length) {
    const trimmed = lines[endIdx].trim();
    if (anyHeaderRe.test(trimmed) && !nestedHeaderRe.test(trimmed)) break;
    endIdx++;
  }

  lines.splice(startIdx, endIdx - startIdx);
  // Avoid leaving a doubled blank-line seam exactly where the block used to
  // be; everything else in the file is left byte-for-byte untouched.
  while (
    startIdx > 0 &&
    startIdx < lines.length &&
    lines[startIdx - 1].trim() === '' &&
    lines[startIdx].trim() === ''
  ) {
    lines.splice(startIdx, 1);
  }
  return lines.join('\n');
}

/**
 * Insert or replace the `[mcp_servers.<serverName>]` table in a Codex CLI
 * `config.toml` file. If the file already exists its content (and every
 * unrelated table) is preserved; only the docgraph table is added/replaced.
 * There is no TOML parser dependency here by design — this uses careful,
 * targeted text manipulation instead of a full parse/serialize round-trip so
 * unrelated formatting and content can never be destroyed.
 */
function upsertCodexToml(filePath: string, serverName: string, command: string[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  const withoutTable = removeTomlTable(existing, `mcp_servers.${serverName}`);
  const block = buildTomlServerBlock(`mcp_servers.${serverName}`, command);
  const trimmed = withoutTable.replace(/\s+$/, '');
  const next = trimmed.length > 0 ? `${trimmed}\n\n${block}` : block;
  writeFileSync(filePath, next.endsWith('\n') ? next : `${next}\n`, 'utf-8');
}

/** Remove exactly the `[mcp_servers.<serverName>]` table added by `upsertCodexToml`. */
function removeCodexToml(filePath: string, serverName: string): void {
  if (!existsSync(filePath)) return;
  const existing = readFileSync(filePath, 'utf-8');
  const updated = removeTomlTable(existing, `mcp_servers.${serverName}`);
  if (updated === existing) return;
  const trimmed = updated.replace(/\s+$/, '');
  writeFileSync(filePath, trimmed.length > 0 ? `${trimmed}\n` : '', 'utf-8');
}

function appendInstructions(filePath: string, marker: string): void {
  const block = `${marker}
# DocGraph MCP

Universal RAG over the project’s documents (markdown, configs, Notion, Jira,
Obsidian, Linear, GitHub, Confluence, ...). Tools:
\`docgraph_search\`, \`docgraph_explore\`, \`docgraph_get_document\`,
\`docgraph_get_related\`, \`docgraph_get_stats\`, \`docgraph_list_documents\`,
\`docgraph_get_document_graph\`, \`docgraph_index_project\`.

Prefer \`docgraph_search\` over grep/Read loops when the user asks how, why,
where, or "what is X" — it returns hybrid (FTS + vector) hits in one call.
${marker.replace('start', 'end')}
`;
  let content = '';
  if (existsSync(filePath)) content = readFileSync(filePath, 'utf-8');
  if (content.includes(marker)) return; // already installed
  content = content.trimEnd() + '\n\n' + block;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

/**
 * Strip the marker-fenced block added by `appendInstructions`, leaving the
 * rest of the instructions file (and any content the user added around it)
 * intact. No-op if the file or marker doesn't exist.
 */
function removeInstructions(filePath: string, marker: string): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf-8');
  if (!content.includes(marker)) return;
  const endMarker = marker.replace('start', 'end');
  const blockRe = new RegExp(`\\n*${escapeRegExp(marker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n*`, 'g');
  const updated = content.replace(blockRe, '\n').trimEnd();
  writeFileSync(filePath, updated.length > 0 ? `${updated}\n` : '', 'utf-8');
}

/** Print the exact config snippet `install` would write for one agent, in its native format. */
function printConfigSnippet(agentId: string): string | null {
  const agent = AGENTS.find((a) => a.id === agentId);
  if (!agent) return null;
  const command = resolveCommand(PORTABLE_LAUNCH);
  if (agent.id === 'opencode') {
    return JSON.stringify({ mcp: { docgraph: { type: 'local', command, enabled: true } } }, null, 2);
  }
  if (agent.id === 'codex') {
    return buildTomlServerBlock('mcp_servers.docgraph', command).trimEnd();
  }
  return JSON.stringify(
    { mcpServers: { docgraph: { command: command[0], args: command.slice(1), type: 'stdio' } } },
    null,
    2,
  );
}

if (process.argv[1]?.endsWith('installer.js') || process.argv[1]?.endsWith('installer.ts')) {
  main().catch((err) => {
    console.error('Installer failed:', err);
    process.exit(1);
  });
}
