// Sets the version of every publishable package (fixed versioning), e.g. `node scripts/set-version.mjs 1.0.0`.
// `@aicd-ci/plugin-sdk` follows the plugin API: its major version must equal PLUGIN_API_VERSION.
import {readdirSync, readFileSync, statSync, writeFileSync} from "node:fs";
import {join} from "node:path";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    console.error("usage: node scripts/set-version.mjs <semver>");
    process.exit(2);
}

const root = new URL("..", import.meta.url).pathname;
const packageDirs = (dir) =>
    readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (!statSync(path).isDirectory() || entry === "node_modules" || entry === "test") return [];
        try {
            statSync(join(path, "package.json"));
            return [path];
        } catch {
            return packageDirs(path);
        }
    });

const sdkSource = readFileSync(join(root, "packages/plugin-sdk/src/plugin.ts"), "utf8");
const apiVersion = Number(/PLUGIN_API_VERSION = (\d+)/.exec(sdkSource)?.[1]);
for (const dir of packageDirs(join(root, "packages"))) {
    const file = join(dir, "package.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    if (manifest.private) continue;
    if (manifest.name === "@aicd-ci/plugin-sdk" && Number(version.split(".")[0]) !== apiVersion) {
        console.error(`@aicd-ci/plugin-sdk major must equal PLUGIN_API_VERSION (${apiVersion})`);
        process.exit(1);
    }
    manifest.version = version;
    writeFileSync(file, `${JSON.stringify(manifest, null, 4)}\n`);
    console.log(`${manifest.name}@${version}`);
}
