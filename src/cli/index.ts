#!/usr/bin/env node
// The Node.js version is checked first, so a too-old Node.js gets a plain message instead of a stack trace.
// Node 22 warns that node:sqlite is experimental as soon as that module loads, which happens before any code
// in a module that imports it. So the warning filter is installed next, then the CLI is loaded.
import "./node-check.js";
import "./quiet-warnings.js";

void import("./main.js");
