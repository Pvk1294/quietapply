#!/usr/bin/env node
// Node 22 warns that node:sqlite is experimental as soon as that module loads, which happens before any code
// in a module that imports it. So the warning filter is installed here first, then the CLI is loaded.
import "./quiet-warnings.js";

await import("./main.js");
