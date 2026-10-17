// The user commands, written once and rendered into each host's own format.
//
// pi and Claude Code both turn a Markdown file into a slash command, and both
// substitute $ARGUMENTS, so one body serves both hosts. Only the location and
// the file name differ:
//
//   pi (prompt template, via package.json "pi.prompts")  pi-prompts/mcp-relay-<name>.md  ->  /mcp-relay-<name>
//   Claude Code (plugin command, from the plugin root)   commands/<name>.md                 ->  /mcp-relay:<name>
//
// `npm run build` writes these files; tests and scripts/verify-package.mjs
// compare the committed and the packed files against this module byte for byte.

export const COMMANDS = [
  {
    name: 'status',
    tool: 'relay_status',
    description: "Report this session's owned VM lease exactly as the relay_status tool sees it. Read-only.",
    body: 'Call the `relay_status` tool once, with no arguments, and report its answer to the user exactly as it is. Do not act on the lease from here: `relay_finish` and `relay_release` are separate relay actions.',
  },
];

/** The directories the build owns completely: any other file in them is stale. */
export const COMMAND_DIRS = { pi: 'pi-prompts', claude: 'commands' };
export const piCommandName = name => `mcp-relay-${name}`;

// JSON strings are valid YAML double-quoted scalars, so every value is quoted
// and a ": " inside a description can never break a strict YAML parser.
const render = command => [
  '---',
  `description: ${JSON.stringify(command.description)}`,
  ...(command.argumentHint ? [`argument-hint: ${JSON.stringify(command.argumentHint)}`] : []),
  '---',
  command.body,
  '',
].join('\n');

/** Every generated file, keyed by its path relative to the package root. */
export function hostCommandFiles() {
  const files = {};
  for (const command of COMMANDS) {
    files[`${COMMAND_DIRS.pi}/${piCommandName(command.name)}.md`] = render(command);
    files[`${COMMAND_DIRS.claude}/${command.name}.md`] = render(command);
  }
  return files;
}
