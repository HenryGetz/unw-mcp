#!/usr/bin/env node
/**
 * `prepare` entrypoint for git / npx installs.
 *
 * npm runs `prepare` inside a temporary clone, and the child npm process inherits the
 * outer install's flags. Under `npm install -g github:…` that means `npm_config_global=true`,
 * so a bare `npm install` here would reify the clone's devDependencies into the *global*
 * prefix — leaving the clone without `@types/node` and failing `tsc`. Install locally with
 * global mode explicitly disabled, then build.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const env = { ...process.env, npm_config_global: "false" };
delete env.npm_config_prefix;
delete env.npm_config_location;

function run(args) {
  const result = spawnSync(npm, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(join(root, "node_modules", "typescript", "bin", "tsc"))) {
  console.error("unw-mcp prepare: installing build dependencies into the checkout");
  run(["install", "--no-save", "--ignore-scripts", "--include=dev", "--no-audit", "--no-fund"]);
}

run(["run", "build"]);
