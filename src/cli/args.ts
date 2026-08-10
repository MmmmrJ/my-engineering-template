import { WorkflowError } from "../workflow/errors.js";

const BOOLEAN_OPTIONS = new Set(["help", "json"]);

export interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, readonly string[]>;
}

export function parseArguments(tokens: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  let positionalOnly = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (positionalOnly || !token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      positionalOnly = true;
      continue;
    }

    const separator = token.indexOf("=");
    const name = token.slice(2, separator === -1 ? undefined : separator);
    if (!name) throw new WorkflowError("USAGE", "Empty option name.");
    let value: string;
    if (separator !== -1) {
      value = token.slice(separator + 1);
    } else if (BOOLEAN_OPTIONS.has(name)) {
      value = "true";
    } else {
      const following = tokens[index + 1];
      if (following === undefined || following.startsWith("--")) {
        throw new WorkflowError("USAGE", `--${name} requires a value.`);
      }
      value = following;
      index += 1;
    }
    const values = options.get(name) ?? [];
    values.push(value);
    options.set(name, values);
  }

  return { positionals, options };
}

export function option(
  args: ParsedArguments,
  name: string,
  options: { required?: boolean } = {},
): string | undefined {
  const values = args.options.get(name) ?? [];
  if (values.length > 1) {
    throw new WorkflowError("USAGE", `--${name} may only be supplied once.`);
  }
  const value = values[0];
  if (options.required && !value?.trim()) {
    throw new WorkflowError("USAGE", `--${name} is required.`);
  }
  return value;
}

export function options(args: ParsedArguments, name: string): readonly string[] {
  return args.options.get(name) ?? [];
}

export function flag(args: ParsedArguments, name: string): boolean {
  return args.options.has(name);
}

export function assertAllowedOptions(args: ParsedArguments, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = [...args.options.keys()].filter((name) => !allowedSet.has(name));
  if (unknown.length > 0) {
    throw new WorkflowError("USAGE", `Unknown option(s): ${unknown.map((name) => `--${name}`).join(", ")}`);
  }
}

export function positional(
  args: ParsedArguments,
  index: number,
  name: string,
  required = true,
): string | undefined {
  const value = args.positionals[index];
  if (required && !value) throw new WorkflowError("USAGE", `${name} is required.`);
  return value;
}

export function assertPositionalCount(args: ParsedArguments, maximum: number): void {
  if (args.positionals.length > maximum) {
    throw new WorkflowError("USAGE", `Unexpected argument: ${args.positionals[maximum]}`);
  }
}

