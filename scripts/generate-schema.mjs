// Writes the JSON Schemas of .aicd.yaml and of the organisation policies (run after `pnpm build`).
import {writeFileSync} from "node:fs";
import {configJsonSchema, policiesJsonSchema} from "../packages/core/dist/index.js";

const write = (file, schema) =>
    writeFileSync(new URL(`../schema/${file}`, import.meta.url), `${JSON.stringify(schema, null, 4)}\n`);
write("aicd.schema.json", configJsonSchema());
write("policies.schema.json", policiesJsonSchema());
console.log("schema/aicd.schema.json and schema/policies.schema.json written");
