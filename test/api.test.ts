import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";

test("Las consultas del panel no agotan las escrituras y el límite sigue activo", async()=>{
 const app=await buildApp();
 try {
   for(let i=0;i<130;i++) assert.equal((await app.inject("/health")).statusCode,200);
   for(let i=0;i<120;i++) assert.notEqual((await app.inject({method:"POST",url:"/api/v1/spaces"})).statusCode,429);
   const blocked=await app.inject({method:"POST",url:"/api/v1/spaces"});
   assert.equal(blocked.statusCode,429);
   assert.match(blocked.json().error.message,/Vuelve a intentar en/);
   assert.ok(blocked.headers["retry-after"]);
   assert.equal((await app.inject("/health")).statusCode,200);
 }finally{await app.close()}
});
test("Salud, CORS, OpenAPI y protección de rutas", async () => {
  const app = await buildApp();
  try {
    const health = await app.inject("/health");
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().status, "ok");
    const unauthorized = await app.inject("/api/v1/accounts");
    assert.ok([401, 503].includes(unauthorized.statusCode));
    assert.ok(unauthorized.json().error.requestId);
    const schema = await app.inject("/docs/json");
    assert.equal(schema.statusCode, 200);
    assert.ok(schema.json().paths["/api/v1/transactions"]);
    assert.ok(schema.json().components.securitySchemes.bearerAuth);
    const cors = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/accounts",
      headers: {
        origin: "https://not-authorized.example",
        "access-control-request-method": "GET",
      },
    });
    assert.equal(cors.headers["access-control-allow-origin"], undefined);
  } finally {
    await app.close();
  }
});
