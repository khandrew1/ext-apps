import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);
const forbidden = [
  "@modelcontextprotocol/client",
  "@modelcontextprotocol/server",
];

for (const dependency of forbidden) {
  if (packageJson.peerDependencies?.[dependency]) {
    throw new Error(`${dependency} must not be a published peer dependency`);
  }
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

for (const file of walk(join(root, "dist", "src"))) {
  if (!/\.(?:js|d\.ts)$/.test(file)) continue;
  const contents = readFileSync(file, "utf8");
  for (const dependency of forbidden) {
    const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const importEdge = new RegExp(
      `(?:from\\s*["']${escaped}|import\\(["']${escaped}["']\\)|require\\(["']${escaped}["']\\))`,
    );
    if (importEdge.test(contents)) {
      throw new Error(
        `${file} has an unintended runtime or declaration edge to ${dependency}`,
      );
    }
  }
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "ext-apps-isolation-"));
try {
  const npmEnvironment = {
    ...process.env,
    npm_config_cache: join(temporaryRoot, "npm-cache"),
  };
  const packOutput = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        temporaryRoot,
      ],
      { cwd: root, encoding: "utf8", env: npmEnvironment },
    ),
  );
  const tarball = join(temporaryRoot, packOutput[0].filename);

  const consumers = [
    {
      name: "app-only",
      dependencies: { "@modelcontextprotocol/ext-apps": `file:${tarball}` },
      absent: forbidden,
      entry:
        'import { App } from "@modelcontextprotocol/ext-apps"; console.log(App);',
      bundleAbsent: ["@modelcontextprotocol/server"],
    },
    {
      name: "server-only",
      dependencies: {
        "@modelcontextprotocol/ext-apps": `file:${tarball}`,
        "@modelcontextprotocol/server": "2.0.0-beta.4",
      },
      absent: ["@modelcontextprotocol/client"],
      entry:
        'import { registerAppTool } from "@modelcontextprotocol/ext-apps/server"; console.log(registerAppTool);',
      bundleAbsent: ["@modelcontextprotocol/client"],
    },
  ];

  for (const consumer of consumers) {
    const directory = join(temporaryRoot, consumer.name);
    mkdirSync(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ private: true, dependencies: consumer.dependencies }),
    );
    execFileSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--package-lock=false",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: directory, stdio: "pipe", env: npmEnvironment },
    );

    writeFileSync(join(directory, "entry.mjs"), consumer.entry);
    const metafile = join(directory, "bundle-meta.json");
    execFileSync(
      join(root, "node_modules", ".bin", "esbuild"),
      [
        "entry.mjs",
        "--bundle",
        "--platform=browser",
        "--outfile=bundle.js",
        `--metafile=${metafile}`,
      ],
      { cwd: directory, stdio: "pipe" },
    );
    const bundleInputs = Object.keys(
      JSON.parse(readFileSync(metafile, "utf8")).inputs,
    ).join("\n");
    for (const dependency of consumer.bundleAbsent) {
      if (bundleInputs.includes(`/node_modules/${dependency}/`)) {
        throw new Error(`${consumer.name} unexpectedly bundled ${dependency}`);
      }
    }

    for (const dependency of consumer.absent) {
      const packagePath = join(
        directory,
        "node_modules",
        ...dependency.split("/"),
      );
      try {
        readFileSync(join(packagePath, "package.json"));
        throw new Error(
          `${consumer.name} unexpectedly installed ${dependency}`,
        );
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log("Dependency isolation checks passed.");
