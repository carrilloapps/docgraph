/**
 * Commands whose first positional argument is a project path.
 * For every other command the first positional argument means something else
 * (a search query, a subcommand, ...) and must NOT be treated as a path.
 */
export const PATH_COMMANDS = new Set(['init', 'index', 'reindex', 'watch', 'stats', 'stats-json', 'list', 'serve']);

/**
 * Resolve the project path from CLI arguments.
 *
 * Precedence: explicit `--path=<dir>` flag, then the first positional argument
 * of a path-taking command, then the current working directory. Crucially, a
 * search query (`docgraph search "auth"`) is never mistaken for a path.
 */
export function resolveProjectPath(argv: string[], cwd: string): string {
  const command = argv[2];
  const args = argv.slice(3);

  const pathFlag = args.find((arg) => arg.startsWith('--path='));
  if (pathFlag) {
    return pathFlag.slice('--path='.length) || cwd;
  }

  if (PATH_COMMANDS.has(command)) {
    const firstPositional = args.find((arg) => !arg.startsWith('-'));
    if (firstPositional) {
      return firstPositional;
    }
  }

  if (command === 'search') {
    const positionalArgs = args.filter((arg) => !arg.startsWith('-'));
    if (positionalArgs.length > 1) {
      return positionalArgs[positionalArgs.length - 1];
    }
    if (positionalArgs.length === 1) {
      return cwd;
    }
  }

  return cwd;
}

/**
 * True when the explicit `--read-only` flag or a truthy `DOCGRAPH_READ_ONLY`
 * env var is present. This is the *highest two* precedence layers of the
 * read-only mode chain (explicit flag → env var → `settings.security.readOnly`);
 * the settings fallback is the caller's responsibility since it requires
 * loading the project's settings file.
 */
export function hasReadOnlyFlagOrEnv(argv: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  if (argv.includes('--read-only')) return true;
  const raw = env.DOCGRAPH_READ_ONLY;
  return raw === '1' || raw?.toLowerCase() === 'true';
}
