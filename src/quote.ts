/** Quoting for the command lines netbridge builds to start the app. */

/**
 * Quote a value for NODE_OPTIONS. Node's parser treats a backslash inside
 * double quotes as an escape, so a Windows path (C:\Users\...) must have its
 * backslashes doubled or it resolves to a file that doesn't exist.
 */
export function quoteNodeOption(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * Quote one argument for a Windows command line (run via cmd.exe /d /s /c).
 * With shell:true Node joins args unquoted, so `-e "a b"` split in two (and
 * Node 24 deprecates passing args alongside shell:true). Follows the C
 * runtime's parsing: quotes around anything with spaces or cmd
 * metacharacters, backslashes doubled before a quote.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg && !/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}
