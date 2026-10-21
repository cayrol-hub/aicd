#!/usr/bin/env node
import {buildProgram} from "./program.js";

let exitCode = 0;
await buildProgram((code) => {
    exitCode = code;
}).parseAsync(process.argv);
process.exitCode = exitCode;
