import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Swagger y Static cargan por CommonJS sin depender de require(ESM)", () => {
  const disableEsm = process.allowedNodeEnvironmentFlags.has(
    "--no-require-module",
  )
    ? "--no-require-module"
    : "--no-experimental-require-module";
  const result = spawnSync(
    process.execPath,
    [
      disableEsm,
      "-e",
      `
   const assert=require('node:assert/strict');
   const {createRequire}=require('node:module');
   const fromSwagger=createRequire(require.resolve('@fastify/swagger-ui'));
   const fromStatic=createRequire(fromSwagger.resolve('@fastify/static'));
   const disposition=fromStatic('content-disposition');
   assert.equal(typeof disposition.create,'function');
   const header=disposition.parse(disposition.create('AFI.pdf'));
   assert.equal(header.type,'attachment');
   assert.equal(header.parameters.filename,'AFI.pdf');
   fromSwagger('@fastify/static');
   require('@fastify/swagger-ui');
   console.log('CommonJS runtime OK');
 `,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /CommonJS runtime OK/);
});
